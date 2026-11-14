import { describe, expect, it } from 'vitest'
import { mergeIncome, payColumns } from '../shared/utils/brandDeal'

const none = { pay_types: [] as string[], flat_fee: null, retainer_fee: null, commission_pct: null, ad_spend_pct: null }

describe('payColumns', () => {
  it('keeps amounts only for chosen types, in a fixed order', () => {
    expect(payColumns(['ad_spend', 'retainer'], { flat_fee: 50, retainer_fee: 2000, commission_pct: 10, ad_spend_pct: 8 })).toEqual({
      pay_types: ['retainer', 'ad_spend'], flat_fee: null, retainer_fee: 2000, commission_pct: null, ad_spend_pct: 8
    })
  })
})

describe('mergeIncome', () => {
  const current = { ...none, pay_types: ['flat', 'commission'], flat_fee: 50, commission_pct: 10 }

  it('adds a type when an amount is given for it, keeping the rest', () => {
    expect(mergeIncome(current, { retainer_fee: 1500 })).toEqual({
      pay_types: ['flat', 'retainer', 'commission'], flat_fee: 50, retainer_fee: 1500, commission_pct: 10, ad_spend_pct: null
    })
  })

  it('replaces the list when types are given, clearing amounts that no longer apply', () => {
    expect(mergeIncome(current, { types: ['ad_spend'], ad_spend_pct: 7 })).toEqual({
      pay_types: ['ad_spend'], flat_fee: null, retainer_fee: null, commission_pct: null, ad_spend_pct: 7
    })
  })

  it('clears an amount with null but keeps its type', () => {
    expect(mergeIncome(current, { commission_pct: null })).toMatchObject({ pay_types: ['flat', 'commission'], commission_pct: null })
  })
})
