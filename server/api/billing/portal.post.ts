// Stripe's Customer Portal for the owner's org: payment method, invoices, changing plan, cancelling.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const { data } = await serviceDb(event).from('org_subscriptions').select('stripe_customer_id').eq('org_id', orgId).maybeSingle()
  if (!data) throw createError({ statusCode: 409, statusMessage: 'This organisation is on Free: choose a plan first.' })
  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
  const session = await stripeClient(event).billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: `${origin}/settings?tab=profile`
  })
  return { url: session.url }
})
