import Stripe from 'stripe'
import type { H3Event } from 'h3'
import { serverSupabaseServiceRole, serverSupabaseUser } from '#supabase/server'
import type { Database } from '#shared/types/database.types'

// Billing (docs/spec.md §2): one Kreate subscription per org, on one of the paid plans (plus any extra
// team places), through Stripe Checkout with Managed
// Payments (Stripe is the merchant of record: tax, fraud, disputes). Stripe is the source of truth:
// every webhook re-reads the subscription from Stripe, so events arriving out of order can't leave
// org_subscriptions stale. Only the server writes billing rows, with the service role.

export function stripeClient(event: H3Event) {
  const key = useRuntimeConfig(event).stripeSecretKey
  if (!key) throw createError({ statusCode: 503, statusMessage: 'Billing isn\'t configured. Set STRIPE_SECRET_KEY.' })
  return new Stripe(key)
}

/** The service-role client: bypasses row level security, so it's only for billing and license writes. */
export const serviceDb = (event: H3Event) => serverSupabaseServiceRole<Database>(event)

const ENTITLED = ['trialing', 'active', 'past_due']
export const isEntitled = (status: string | null | undefined) => !!status && ENTITLED.includes(status)

/** The org a Stripe subscription belongs to: its metadata, else the org that owns its customer. */
async function orgOf(db: ReturnType<typeof serviceDb>, subscription: Stripe.Subscription) {
  if (subscription.metadata?.org_id) return subscription.metadata.org_id
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const { data } = await db.from('org_subscriptions').select('org_id').eq('stripe_customer_id', customer).maybeSingle()
  return data?.org_id ?? null
}

/** Copy a subscription's current state from Stripe into org_subscriptions. */
export async function syncSubscription(event: H3Event, subscriptionId: string) {
  const stripe = stripeClient(event)
  const db = serviceDb(event)
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const orgId = await orgOf(db, subscription)
  if (!orgId) throw new Error(`No org for subscription ${subscriptionId}`)
  // the plan's item (its price's lookup key names the plan) and the team member add-on's, if any
  const items = subscription.items.data
  const isAgencyItem = (lookupKey: string | null | undefined) => lookupKey === AGENCY_PLAN.lookupKey
  const item = items.find(i => planForLookupKey(i.price.lookup_key) || isAgencyItem(i.price.lookup_key)) ?? items[0]
  const teamItem = items.find(i => i.price.lookup_key === TEAM_MEMBER.lookupKey)
  // a brand's or agency's seats: the seat price's quantity
  const seatItem = items.find(i => SEAT_LOOKUP_KEYS.includes(i.price.lookup_key ?? ''))
  const seconds = (value: number | null | undefined) => value ? new Date(value * 1000).toISOString() : null
  const { error } = await db.from('org_subscriptions').upsert({
    org_id: orgId,
    stripe_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    price_id: item?.price.id ?? null,
    plan: planForLookupKey(item?.price.lookup_key) ?? (isAgencyItem(item?.price.lookup_key) ? 'agency' : null),
    extra_team: teamItem?.quantity ?? 0,
    seats: seatItem?.quantity ?? 0,
    current_period_end: seconds(item?.current_period_end),
    trial_end: seconds(subscription.trial_end),
    cancel_at_period_end: subscription.cancel_at_period_end,
    ...(subscription.trial_end ? { trial_used: true } : {}),
    synced_at: new Date().toISOString()
  }, { onConflict: 'org_id' })
  if (error) throw error
  // seats waiting for a live subscription start now (up to what's paid for)
  if (seatItem && isEntitled(subscription.status)) await activatePendingSeats(event, orgId, seatItem.quantity ?? 0)
}

/** Switch on a payer's pending seats, oldest first, as far as the seats paid for go. */
export async function activatePendingSeats(event: H3Event, orgId: string, paid: number) {
  const db = serviceDb(event)
  const { data: current } = await db.from('seats').select('id, status').eq('publisher_org_id', orgId).neq('status', 'ended').order('assigned_at')
  const active = (current ?? []).filter(seat => seat.status === 'active').length
  const toStart = (current ?? []).filter(seat => seat.status === 'pending').slice(0, Math.max(0, paid - active)).map(seat => seat.id)
  if (toStart.length) {
    const { error } = await db.from('seats').update({ status: 'active' }).in('id', toStart)
    if (error) throw error
  }
}

/** The org's Stripe customer, made the first time it's needed (one per org, reused for everything). */
export async function ensureCustomer(event: H3Event, orgId: string) {
  const db = serviceDb(event)
  const [{ data: existing }, { data: org }] = await Promise.all([
    db.from('org_subscriptions').select('*').eq('org_id', orgId).maybeSingle(),
    db.from('orgs').select('name').eq('id', orgId).single()
  ])
  if (existing) return { customer: existing.stripe_customer_id, subscription: existing }
  const user = await serverSupabaseUser(event)
  const created = await stripeClient(event).customers.create(
    { name: org?.name, email: user?.email, metadata: { org_id: orgId } },
    { idempotencyKey: `org-customer-${orgId}` }
  )
  const { error } = await db.from('org_subscriptions').insert({ org_id: orgId, stripe_customer_id: created.id })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { customer: created.id, subscription: null }
}

/** A Stripe price by its lookup key. */
export async function priceFor(event: H3Event, lookupKey: string) {
  const prices = await stripeClient(event).prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
  const price = prices.data[0]
  if (!price) throw createError({ statusCode: 503, statusMessage: `No active price with lookup key ${lookupKey}` })
  return price
}

/** The signed-in owner's org, for starting checkout, opening the portal or buying team places. */
export async function requireOrgOwner(event: H3Event) {
  const access = await requireMember(event)
  if (!access.owner) throw createError({ statusCode: 403, statusMessage: 'Only the owner can manage billing' })
  return access
}

/**
 * Record a Klip purchase from its Checkout Session, re-read from Stripe: the org has Klip
 * once it's paid, unless it's since been refunded in full (so a replayed event can't hand it back).
 */
export async function syncKlipPurchase(event: H3Event, sessionId: string) {
  const session = await stripeClient(event).checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge'] })
  const orgId = session.metadata?.org_id
  const intent = session.payment_intent as Stripe.PaymentIntent | null
  if (session.metadata?.purchase !== 'klip' || !orgId || !intent || session.payment_status !== 'paid') return
  const charge = intent.latest_charge as Stripe.Charge | null
  if (charge?.refunded) return
  const { error } = await serviceDb(event).from('orgs')
    .update({ klip_purchased_at: new Date(session.created * 1000).toISOString(), klip_payment_intent_id: intent.id })
    .eq('id', orgId)
  if (error) throw error
}

/** A full refund of the Klip purchase takes Klip away again. */
export async function refundKlipPurchase(event: H3Event, charge: Stripe.Charge) {
  const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!charge.refunded || !intent) return
  const { error } = await serviceDb(event).from('orgs').update({ klip_purchased_at: null }).eq('klip_payment_intent_id', intent)
  if (error) throw error
}
