// Pay for a partnered creator's shoots, or stop (restructure Phase 5): the owner of a brand or agency
// account gives a creator account a seat, or ends one. A seat is the payer's seat price's quantity
// (graduated: SEAT_STEPS), prorated. With no live subscription yet, the seat waits (pending) and this
// returns a Checkout URL for the seats; the webhook starts them once it's paid.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const body = await readBody<{ creatorOrgId?: string, on?: boolean }>(event).catch(() => null)
  const creatorOrgId = String(body?.creatorOrgId ?? '')
  const on = body?.on !== false

  const db = serviceDb(event)
  const { data: org } = await db.from('orgs').select('name, kind').eq('id', orgId).single()
  if (!org || org.kind === 'creator') throw createError({ statusCode: 403, statusMessage: 'Seats are for brand and agency accounts' })
  const seatKind: SeatKind = org.kind === 'agency' ? 'agency' : 'brand'

  // a seat is for a creator you partner with
  const { data: partnership } = await db.from('partnerships').select('creator_name')
    .eq('publisher_org_id', orgId).eq('creator_org_id', creatorOrgId).eq('status', 'active').limit(1).maybeSingle()
  if (on && !partnership) throw createError({ statusCode: 400, statusMessage: 'You can only pay for creators you partner with' })

  const { data: current } = await db.from('seats').select('id, status').eq('publisher_org_id', orgId).eq('creator_org_id', creatorOrgId).neq('status', 'ended').maybeSingle()
  if (on && !current) {
    const { error } = await db.from('seats').insert({ publisher_org_id: orgId, creator_org_id: creatorOrgId, publisher_name: org.name, creator_name: partnership!.creator_name ?? 'A creator' })
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  } else if (!on && current) {
    const { error } = await db.from('seats').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', current.id)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  }

  const { count } = await db.from('seats').select('id', { count: 'exact', head: true }).eq('publisher_org_id', orgId).neq('status', 'ended')
  const seats = count ?? 0
  const { customer, subscription } = await ensureCustomer(event, orgId)
  const stripe = stripeClient(event)
  const price = await priceFor(event, SEATS[seatKind].lookupKey)
  const proration_behavior = 'create_prorations' as const

  // a live subscription: set its seat quantity (adding the seat price if it hasn't one)
  if (subscription?.stripe_subscription_id && isEntitled(subscription.status)) {
    const live = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id)
    const item = live.items.data.find(i => SEAT_LOOKUP_KEYS.includes(i.price.lookup_key ?? ''))
    if (item) {
      if (item.quantity !== seats) await stripe.subscriptionItems.update(item.id, { quantity: seats, proration_behavior })
    } else if (seats) {
      await stripe.subscriptionItems.create({ subscription: live.id, price: price.id, quantity: seats, proration_behavior })
    }
    await syncSubscription(event, live.id)
    return { seats, url: null }
  }
  if (!seats) return { seats, url: null }

  // no live subscription yet: Checkout for the seats; they start once it's paid
  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: orgId,
    line_items: [{ price: price.id, quantity: seats }],
    managed_payments: { enabled: true },
    subscription_data: { metadata: { org_id: orgId } },
    integration_identifier: 'top_dog_kit_subscribe_qmrtvwkz',
    success_url: `${origin}/creators?seats=success`,
    cancel_url: `${origin}/creators`
  })
  return { seats, url: session.url }
})
