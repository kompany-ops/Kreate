import type { PayType } from '#shared/utils/brandDeal'

type Color ='primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export const BRAND_STATUSES = ['prospect', 'auditioning', 'piloting', 'active', 'paused'] as const

export const BRAND_STATUS_COLORS: Record<string, Color> = {
  prospect: 'neutral',
  auditioning: 'info',
  piloting: 'primary',
  active: 'success',
  paused: 'warning'
}

export const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'].map(code => ({ label: code, value: code }))

export function currencySymbol(code: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(part => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
}

type DealRow = {
  pay_types: string[]
  flat_fee: number | null
  retainer_fee: number | null
  commission_pct: number | null
  ad_spend_pct: number | null
  currency: string
}

/** "£150 / video + £2,000 / month + 10% commission + 8% of ad spend", or null when no terms are set (or no deal row). */
export function dealSummary(brand: DealRow | null | undefined): string | null {
  if (!brand) return null
  const money = (amount: number | null, per: string) => amount === null ? null : `${formatMoney(Number(amount), brand.currency)} / ${per}`
  const pct = (amount: number | null, of: string) => amount === null ? null : `${Number(amount)}% ${of}`
  const amounts: Record<PayType, string | null> = {
    flat: money(brand.flat_fee, 'video'),
    retainer: money(brand.retainer_fee, 'month'),
    commission: pct(brand.commission_pct, 'commission'),
    ad_spend: pct(brand.ad_spend_pct, 'of ad spend')
  }
  const parts = PAY_TYPES.filter(type => brand.pay_types.includes(type.value))
    .map(type => amounts[type.value] ?? type.label)
  return parts.length ? parts.join(' + ') : null
}

/**
 * Form state for BrandDealFields from a brand's deal (brand_deals: the team's only) and its Trybe
 * fields (on brands), or blank for a new brand.
 */
export function toBrandDeal(deal?: DealRow | null, brand?: { trybe_score: number | null, trybe_url: string | null } | null) {
  return {
    pay_types: [...(deal?.pay_types ?? [])],
    flat_fee: deal?.flat_fee ?? undefined,
    retainer_fee: deal?.retainer_fee ?? undefined,
    commission_pct: deal?.commission_pct ?? undefined,
    ad_spend_pct: deal?.ad_spend_pct ?? undefined,
    currency: deal?.currency ?? 'GBP',
    trybe_score: brand?.trybe_score ?? undefined,
    trybe_url: brand?.trybe_url ?? ''
  }
}

/**
 * What to save from BrandDealFields: `deal` for brand_deals, `brand` (the Trybe fields) for brands.
 * Amounts for income types that aren't ticked are cleared.
 */
export function fromBrandDeal(deal: ReturnType<typeof toBrandDeal>) {
  const number = (value: number | undefined | string) => value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value)
  return {
    deal: {
      ...payColumns(deal.pay_types, {
        flat_fee: number(deal.flat_fee),
        retainer_fee: number(deal.retainer_fee),
        commission_pct: number(deal.commission_pct),
        ad_spend_pct: number(deal.ad_spend_pct)
      }),
      currency: deal.currency
    },
    brand: {
      trybe_score: number(deal.trybe_score),
      trybe_url: normalizeUrl(deal.trybe_url)
    }
  }
}

export const SHOOT_STATUS_COLORS: Record<string, Color> = {
  draft: 'neutral',
  planned: 'info',
  shooting: 'warning',
  filmed: 'success',
  editing: 'warning',
  edited: 'primary'
}

/** What a shoot status reads as: `edited` is Live (the edits checked, recipes built, batches running). */
export const SHOOT_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  planned: 'Planned',
  shooting: 'Shooting',
  filmed: 'Filmed',
  editing: 'Editing',
  edited: 'Live'
}

/** A Live shoot's batches: picked, rendering in Showdog, submitted to the brand, then measured (every element scored). */
export const BATCH_STATUS_LABELS: Record<string, string> = {
  batched: 'Batched',
  rendering: 'Rendering',
  submitted: 'Submitted',
  measured: 'Measured'
}

export const BATCH_STATUS_COLORS: Record<string, Color> = {
  batched: 'neutral',
  rendering: 'warning',
  submitted: 'info',
  measured: 'success'
}

/** One colour per batch, in order, for the usage bar. */
export const BATCH_COLORS = ['bg-primary', 'bg-info', 'bg-success', 'bg-warning', 'bg-secondary', 'bg-error']

export const ITEM_STATUS_COLORS: Record<string, Color> = {
  planned: 'neutral',
  filmed: 'success',
  skipped: 'warning'
}

export const KIND_LABELS = { hook: 'Hook', body: 'VO', cta: 'CTA' } as const

export const selectOptions = (values: readonly string[]) =>
  values.map(value => ({ label: value.charAt(0).toUpperCase() + value.slice(1), value }))

export function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const formatNumber = (value: number, digits = 0) =>
  value.toLocaleString(undefined, { maximumFractionDigits: digits })

/** Button `ui` that drops the label below the `sm` breakpoint; pair with `class="max-sm:px-1.5"` and an `aria-label`. */
export const ICON_ON_MOBILE = { label: 'hidden sm:inline' }
