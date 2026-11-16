// Set how many extra team places the owner's org pays for, on top of its plan's: the team member
// add-on's quantity on its subscription, prorated. Free can't buy any. The webhook copies the
// quantity into org_subscriptions.extra_team, and the database lets the team grow to match.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const body = await readBody<{ extra?: number }>(event).catch(() => null)
  const extra = Number(body?.extra)
  if (!Number.isInteger(extra) || extra < 0 || extra > 50) {
    throw createError({ statusCode: 400, statusMessage: 'Extra team places must be a whole number from 0 to 50.' })
  }

  const db = serviceDb(event)
  const { data: row } = await db.from('org_subscriptions').select('stripe_subscription_id, status').eq('org_id', orgId).maybeSingle()
  if (!row?.stripe_subscription_id || !isEntitled(row.status)) {
    throw createError({ statusCode: 409, statusMessage: 'Extra team places need a paid plan: choose one first.' })
  }

  const stripe = stripeClient(event)
  const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id)
  const item = subscription.items.data.find(i => i.price.lookup_key === TEAM_MEMBER.lookupKey)
  const proration_behavior = 'create_prorations' as const
  if (extra === 0) {
    if (item) await stripe.subscriptionItems.del(item.id, { proration_behavior })
  } else if (item) {
    if (item.quantity !== extra) await stripe.subscriptionItems.update(item.id, { quantity: extra, proration_behavior })
  } else {
    const price = await priceFor(event, TEAM_MEMBER.lookupKey)
    await stripe.subscriptionItems.create({ subscription: subscription.id, price: price.id, quantity: extra, proration_behavior })
  }

  // don't wait for the webhook: the owner is about to add someone
  await syncSubscription(event, subscription.id)
  return { extra }
})
