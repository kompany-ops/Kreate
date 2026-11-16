import type { PaidPlanId } from '#shared/utils/plans'

// Start a paid plan for the owner's org: Stripe-hosted Checkout with Managed Payments, and the org
// on the subscription's metadata so the webhook knows whose it is. Pro has a 30-day trial the first
// time (card on file). Moving between paid plans afterwards happens in the Customer Portal.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgOwner(event)
  const body = await readBody<{ plan?: string }>(event).catch(() => null)
  const planId = body?.plan
  const { data: account } = await serviceDb(event).from('orgs').select('kind').eq('id', orgId).single()
  // an agency account's one plan; a creator's Starter, Pro or Studio
  const agency = account?.kind === 'agency'
  if (agency ? planId !== 'agency' : !isPaidPlan(planId)) throw createError({ statusCode: 400, statusMessage: agency ? 'Agencies start the agency plan.' : 'Choose Starter, Pro or Studio.' })
  const plan = agency ? { lookupKey: AGENCY_PLAN.lookupKey, trial: false } : PLANS[planId as PaidPlanId]
  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin

  const { customer, subscription } = await ensureCustomer(event, orgId)
  if (isEntitled(subscription?.status)) {
    throw createError({ statusCode: 409, statusMessage: 'This account already has a plan: change it with Manage billing.' })
  }
  const price = await priceFor(event, plan.lookupKey!)

  const session = await stripeClient(event).checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: orgId,
    line_items: [{ price: price.id, quantity: 1 }],
    managed_payments: { enabled: true },
    subscription_data: {
      metadata: { org_id: orgId },
      // one free trial per org, on Pro
      ...(plan.trial && !subscription?.trial_used ? { trial_period_days: 30 } : {})
    },
    integration_identifier: 'top_dog_kit_subscribe_qmrtvwkz',
    success_url: `${origin}/settings?tab=profile&checkout=success`,
    cancel_url: `${origin}/settings?tab=profile`
  })
  return { url: session.url }
})
