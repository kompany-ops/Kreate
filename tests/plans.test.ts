import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PLAN_ORDER, PLANS, planForLookupKey } from '../shared/utils/plans'

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
