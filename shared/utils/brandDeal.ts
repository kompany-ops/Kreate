// How a brand pays us: any mix of four income types, each with its own amount.
// Shared by the brand forms and the AI connector.

export const PAY_TYPES = [
  { value: 'flat', label: 'Flat fee', field: 'flat_fee', unit: 'money', help: 'Per approved video' },
  { value: 'retainer', label: 'Retainer', field: 'retainer_fee', unit: 'money', help: 'Per month' },
  { value: 'commission', label: 'Commission', field: 'commission_pct', unit: 'pct', help: 'On sales' },
  { value: 'ad_spend', label: 'Ad spend', field: 'ad_spend_pct', unit: 'pct', help: 'Of what the brand spends running our videos' }
] as const

export type PayType = typeof PAY_TYPES[number]['value']
export const PAY_TYPE_VALUES = PAY_TYPES.map(type => type.value) as [PayType, ...PayType[]]

export interface PayAmounts {
  flat_fee?: number | null
  retainer_fee?: number | null
  commission_pct?: number | null
  ad_spend_pct?: number | null
}

/**
 * A partial change to a brand's income on top of what it has (for the AI connector):
 * `types` replaces the list when given; an amount given for a type that isn't on the list adds
 * that type; amounts left out are kept; null clears one.
 */
export function mergeIncome(current: PayAmounts & { pay_types: readonly string[] }, change: PayAmounts & { types?: readonly string[] }) {
  const pick = <K extends keyof PayAmounts>(key: K) => change[key] !== undefined ? change[key] ?? null : current[key] ?? null
  const amounts = { flat_fee: pick('flat_fee'), retainer_fee: pick('retainer_fee'), commission_pct: pick('commission_pct'), ad_spend_pct: pick('ad_spend_pct') }
  const types = new Set(change.types ?? current.pay_types)
  if (!change.types) for (const type of PAY_TYPES) if (typeof change[type.field] === 'number') types.add(type.value)
  return payColumns([...types], amounts)
}

/** The columns to save:the chosen types in a fixed order, and each amount only if its type is chosen. */
export function payColumns(types: readonly string[], amounts: PayAmounts) {
  const has = (type: PayType) => types.includes(type)
  return {
    pay_types: PAY_TYPE_VALUES.filter(has),
    flat_fee: has('flat') ? amounts.flat_fee ?? null : null,
    retainer_fee: has('retainer') ? amounts.retainer_fee ?? null : null,
    commission_pct: has('commission') ? amounts.commission_pct ?? null : null,
    ad_spend_pct: has('ad_spend') ? amounts.ad_spend_pct ?? null : null
  }
}
