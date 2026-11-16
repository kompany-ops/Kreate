import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PLAN_ORDER, PLANS, planForLookupKey, seatsTotal, seatUnitCents } from '../shared/utils/plans'

const sql = readFileSync(new URL('../supabase/migrations/20261120010000_plans.sql', import.meta.url), 'utf8')

/** the rows of private.plan_limits: plan → [team, cast, channels, brands, shoots a month] */
const sqlLimits = () => Object.fromEntries(
  [...sql.matchAll(/\('(\w+)',\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+)\)/g)]
    .map(([, plan, ...values]) => [plan, values.map(v => v === 'null' ? null : Number(v))])
)

describe('plans', () => {
  it('match private.plan_limits in the database', () => {
    const rows = sqlLimits()
    for (const id of PLAN_ORDER) {
      const { team, cast, channels, brands, shootsPerMonth } = PLANS[id].limits
      expect(rows[id], id).toEqual([team, cast, channels, brands, shootsPerMonth])
    }
  })

  it('go up in price and never include less', () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const below = PLANS[PLAN_ORDER[i - 1]!]
      const plan = PLANS[PLAN_ORDER[i]!]
      expect(plan.price).toBeGreaterThan(below.price)
      for (const key of Object.keys(plan.limits) as (keyof typeof plan.limits)[]) {
        const a = below.limits[key] ?? Infinity
        const b = plan.limits[key] ?? Infinity
        expect(b, `${plan.id} ${key}`).toBeGreaterThanOrEqual(a)
      }
    }
  })

  it('find the plan from a price lookup key, including the old one', () => {
    expect(planForLookupKey('kreate_starter')).toBe('starter')
    expect(planForLookupKey('kreate_studio')).toBe('studio')
    expect(planForLookupKey('top_dog_kit_monthly')).toBe('pro')
    expect(planForLookupKey('kreate_team_member')).toBeNull()
    expect(planForLookupKey(null)).toBeNull()
  })
})

describe('seats', () => {
  it('match the graduated prices in Stripe, step by step', () => {
    // cents per seat in each step, as created in Stripe
    expect([0, 0.15, 0.25, 0.35].map(off => seatUnitCents('brand', off))).toEqual([4499, 3824, 3374, 2924])
    expect([0, 0.15, 0.25, 0.35].map(off => seatUnitCents('agency', off))).toEqual([7499, 6374, 5624, 4874])
  })

  it('cost each seat at its own step, so more seats never cost less', () => {
    expect(seatsTotal('brand', 1)).toBe(44.99)
    expect(seatsTotal('brand', 9)).toBe(404.91)
    expect(seatsTotal('brand', 10)).toBe(443.15)
    expect(seatsTotal('brand', 50)).toBeCloseTo(9 * 44.99 + 15 * 38.24 + 25 * 33.74 + 29.24, 2)
    for (let n = 1; n < 80; n++) expect(seatsTotal('agency', n + 1)).toBeGreaterThan(seatsTotal('agency', n))
  })
})
