// Kreate's plans (docs/spec.md §2, Billing): what each costs and includes. The database has the same
// limits in private.plan_limits (supabase/migrations/20261120010000_plans.sql); tests/plans.test.ts
// keeps the two in step. Null means unlimited. Limits count across the whole org, never per channel.

export type PlanId = 'free' | 'starter' | 'pro' | 'studio'
export type PaidPlanId = Exclude<PlanId, 'free'>

export interface PlanLimits {
  /** people who plan and run the account, the owner included */
  team: number
  /** people on camera, who don't pay */
  cast: number | null
  channels: number | null
  /** the org's own brands that aren't archived */
  brands: number | null
  /** shoots marked Planned, by the month they happen in */
  shootsPerMonth: number | null
}

export interface Plan {
  id: PlanId
  title: string
  /** USD a month */
  price: number
  /** the Stripe price's lookup key (none for Free) */
  lookupKey: string | null
  description: string
  limits: PlanLimits
  treatments: 'basic' | 'moderate' | 'advanced'
  klipIncluded: boolean
  /** the plan with the free trial */
  trial: boolean
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    title: 'Free',
    price: 0,
    lookupKey: null,
    description: 'Try Kreate on one channel, or start on a brand that invited you.',
    limits: { team: 1, cast: 1, channels: 1, brands: 1, shootsPerMonth: 1 },
    treatments: 'basic',
    klipIncluded: false,
    trial: false
  },
  starter: {
    id: 'starter',
    title: 'Starter',
    price: 59.99,
    lookupKey: 'kreate_starter',
    description: 'For a creator on one channel, filming every week.',
    limits: { team: 1, cast: 2, channels: 1, brands: 5, shootsPerMonth: 4 },
    treatments: 'basic',
    klipIncluded: false,
    trial: false
  },
  pro: {
    id: 'pro',
    title: 'Pro',
    price: 99.99,
    lookupKey: 'kreate_pro',
    description: 'For a busy setup across a few channels.',
    limits: { team: 2, cast: 6, channels: 3, brands: 10, shootsPerMonth: 10 },
    treatments: 'moderate',
    klipIncluded: false,
    trial: true
  },
  studio: {
    id: 'studio',
    title: 'Studio',
    price: 199.99,
    lookupKey: 'kreate_studio',
    description: 'For collectives: unlimited channels, cast and shoots, with Klip included.',
    limits: { team: 3, cast: null, channels: null, brands: null, shootsPerMonth: null },
    treatments: 'advanced',
    klipIncluded: true,
    trial: false
  }
}

export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro', 'studio']
export const PAID_PLANS: PaidPlanId[] = ['starter', 'pro', 'studio']

/** An agency account's plan (restructure Phase 6): many brands, a roster, its own Library; needed to invite creators. */
export const AGENCY_PLAN = { title: 'Agency', price: 99, lookupKey: 'kreate_agency' } as const

/** An extra team place on a paid plan. */
export const TEAM_MEMBER = { price: 29.99, lookupKey: 'kreate_team_member' } as const

/**
 * Seats (restructure Phase 5): a brand or agency pays per partnered creator, on one graduated
 * price. Each step's discount applies to the seats above it, so a larger roster never costs less
 * in total than a smaller one.
 */
export type SeatKind = 'brand' | 'agency'
export const SEATS: Record<SeatKind, { price: number, lookupKey: string }> = {
  brand: { price: 44.99, lookupKey: 'kreate_brand_seat' },
  agency: { price: 74.99, lookupKey: 'kreate_agency_seat' }
}
/** The steps, as in Stripe: seats up to `upTo` (null: the rest) at `off` the full price. */
export const SEAT_STEPS: { upTo: number | null, off: number }[] = [
  { upTo: 9, off: 0 }, { upTo: 24, off: 0.15 }, { upTo: 49, off: 0.25 }, { upTo: null, off: 0.35 }
]
export const SEAT_LOOKUP_KEYS = Object.values(SEATS).map(seat => seat.lookupKey)

/** One seat's price at a step, in cents, rounded down as in Stripe. */
export const seatUnitCents = (kind: SeatKind, off: number) => Math.floor(Math.round(SEATS[kind].price * 100) * (1 - off))

/** What `count` seats cost a month, in dollars: each seat at the price of its step. */
export function seatsTotal(kind: SeatKind, count: number): number {
  let cents = 0
  let from = 0
  for (const step of SEAT_STEPS) {
    const upTo = step.upTo ?? Infinity
    const inStep = Math.max(0, Math.min(count, upTo) - from)
    cents += inStep * seatUnitCents(kind, step.off)
    from = upTo
    if (count <= upTo) break
  }
  return cents / 100
}

/** Prices from before plans: subscriptions on them are on this plan. */
export const LEGACY_LOOKUP_KEYS: Record<string, PaidPlanId> = { top_dog_kit_monthly: 'pro' }

export const isPaidPlan = (value: unknown): value is PaidPlanId => PAID_PLANS.includes(value as PaidPlanId)

/** The plan a Stripe price's lookup key is for, if any. */
export function planForLookupKey(key: string | null | undefined): PaidPlanId | null {
  if (!key) return null
  const plan = PAID_PLANS.find(id => PLANS[id].lookupKey === key)
  return plan ?? LEGACY_LOOKUP_KEYS[key] ?? null
}

/** "3", or "Unlimited" */
export const limitLabel = (value: number | null) => value === null ? 'Unlimited' : String(value)
