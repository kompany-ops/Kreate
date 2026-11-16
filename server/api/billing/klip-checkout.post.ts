// Buy Klip for the owner's org: a one-time payment through Stripe-hosted Checkout with Managed
// Payments, on the org's Stripe customer (made now if it's on Free). Studio includes Klip already.
// The org has Klip once the webhook has recorded it.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const config = useRuntimeConfig(event)
  const stripe = stripeClient(event)
  const db = serviceDb(event)
  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin

  const { data: org } = await db.from('orgs').select('billing_exempt, klip_purchased_at').eq('id', orgId).single()
  if (org?.klip_purchased_at || org?.billing_exempt) {
    throw createError({ statusCode: 409, statusMessage: 'This organisation already has Klip.' })
  }
  const { data: sub } = await db.from('org_subscriptions').select('plan, status').eq('org_id', orgId).maybeSingle()
  if (sub?.plan === 'studio' && isEntitled(sub.status)) throw createError({ statusCode: 409, statusMessage: 'Studio includes Klip already.' })
  const { customer } = await ensureCustomer(event, orgId)

  const prices = await stripe.prices.list({ lookup_keys: [config.stripeKlipPriceLookupKey], active: true, limit: 1 })
  const price = prices.data[0]
  if (!price) throw createError({ statusCode: 503, statusMessage: `No active price with lookup key ${config.stripeKlipPriceLookupKey}` })

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: orgId,
    line_items: [{ price: price.id, quantity: 1 }],
    managed_payments: { enabled: true },
    metadata: { org_id: orgId, purchase: 'klip' },
    payment_intent_data: { metadata: { org_id: orgId, purchase: 'klip' } },
    integration_identifier: 'ugc_klip_purchase_hwqzrnfd',
    success_url: `${origin}/settings?tab=profile&klip=success`,
    cancel_url: `${origin}/settings?tab=profile`
  })
  return { url: session.url }
})
