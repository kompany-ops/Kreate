// Kreate ↔ Kanvas (docs/contract-kanvas.md): the static plan Kreate hands Kanvas in the manifest
// (`plan.static`), and Kanvas's index (`edited/_kanvas.json`) that Kreate reads back. Kanvas prepares
// assets and renders static ads; Kreate decides which ads exist. Pure.
import { z } from 'zod'
import type { BrandKit, BundleStatics, CopySlot, StaticRules, StaticSlot, StaticSize, StaticVariant } from './statics'
import {
  copyChannels, copyContext, parseBrandKit, parseCopySlots, parseStaticReferences, parseStaticRules, parseStaticSlots, renderCopy
} from './statics'

/** The contract version in docs/contract-kanvas.md, its example index, and Kanvas's copy. */
export const KANVAS_CONTRACT_VERSION = 1

// --- the static plan (manifest.plan.static) ------------------------------------------------

export interface PlanStaticFormat {
  code: string
  name: string
  description: string | null
  mechanism: string | null
  slots: StaticSlot[]
  variants: StaticVariant[]
  rules: StaticRules
  /** example ads: `path` in Kreate's static-references storage, `url` a signed link to it (added when the manifest is written) */
  references: { path: string, source_url: string | null, url?: string }[]
  plate: boolean
  text_render: string
  sizes: StaticSize[]
}

export interface PlanStaticCopy {
  code: string
  format: string
  /** the channel it's for (null: every channel on the shoot) */
  channel: string | null
  /** the product feature it's about */
  feature: string | null
  /** as written, slots unfilled */
  slots: CopySlot[]
  /** filled for each channel it's for: slot → first wording, and its other wordings */
  filled: Record<string, { slot: string, text: string, alternates: string[] }[]>
}

export interface PlanStill {
  id: string
  kind: 'product' | 'avatar'
  description: string
  count: number
  feature: string | null
}

export interface PlanStatic {
  /** extra recipes per copy from mixing its slots' other wordings */
  wording_variations: number
  formats: PlanStaticFormat[]
  /** the brand's design kit: files as `path` in Kreate's brand-kits storage with a signed `url`, packshots in Dropbox (`dropbox_path`/packshots) */
  brand_kit: (Omit<BrandKit, 'logos' | 'fonts'> & {
    logos: { path: string, use: string, url?: string }[]
    fonts: { role: string, family: string, file: string | null, url?: string }[]
  }) | null
  copies: PlanStaticCopy[]
  stills: PlanStill[]
}

interface StaticPlanBundle {
  shoot: { slot_values?: unknown, static_wording_variations?: number }
  brand: { name: string }
  product: { name: string }
  channels: { id: string, name: string, slug: string, slot_values?: unknown }[]
  statics?: BundleStatics
}

/** What Kanvas works from, for a shoot with static formats (null without). */
export function buildStaticPlan(bundle: StaticPlanBundle): PlanStatic | null {
  const statics = bundle.statics
  if (!statics?.formats.length) return null
  const featureSlug = (id: string | null) => statics.features?.find(feature => feature.id === id)?.slug ?? null
  const kit = statics.kit ? parseBrandKit(statics.kit) : null
  const hasKit = kit && (kit.colors.length || kit.fonts.length || kit.logos.length || kit.style_notes || kit.rules.always.length || kit.rules.never.length)
  return {
    wording_variations: bundle.shoot.static_wording_variations ?? 1,
    formats: statics.formats.map(format => ({
      code: format.code,
      name: format.name,
      description: format.description,
      mechanism: format.mechanism,
      slots: parseStaticSlots(format.slots),
      variants: format.variants as StaticVariant[],
      rules: parseStaticRules(format.rules),
      references: parseStaticReferences(format.reference_images),
      plate: format.plate,
      text_render: format.text_render,
      sizes: format.sizes as StaticSize[]
    })),
    brand_kit: hasKit ? { ...kit, logos: kit.logos.map(logo => ({ ...logo })), fonts: kit.fonts.map(font => ({ ...font })) } : null,
    copies: statics.copies.map((copy) => {
      const slots = parseCopySlots(copy.slots)
      return {
        code: copy.code,
        format: statics.formats.find(format => format.id === copy.static_format_id)?.code ?? '',
        channel: bundle.channels.find(channel => channel.id === copy.cast_channel_id)?.slug ?? null,
        feature: featureSlug(copy.feature_id),
        slots,
        filled: Object.fromEntries(copyChannels(bundle.channels, copy).map(channel => [channel.slug, renderCopy(slots, copyContext(bundle, channel)).slots]))
      }
    }),
    stills: statics.stills.filter(still => still.status !== 'skipped').map(still => ({
      id: still.id,
      kind: still.kind as 'product' | 'avatar',
      description: still.description,
      count: still.count,
      feature: featureSlug(still.feature_id)
    }))
  }
}

/** The parts of the static plan that change what Kanvas makes, for the plan hash (no signed links). */
export function staticPlanHashInput(plan: PlanStatic | null) {
  if (!plan) return null
  return {
    formats: plan.formats.map(({ references, ...format }) => ({ ...format, references: references.map(ref => ref.path) })),
    copies: plan.copies.map(copy => ({ code: copy.code, format: copy.format, filled: copy.filled })),
    stills: plan.stills.map(still => ({ id: still.id, kind: still.kind, count: still.count })),
    kit: plan.brand_kit ? { colors: plan.brand_kit.colors, fonts: plan.brand_kit.fonts.map(font => font.family), logos: plan.brand_kit.logos.map(logo => logo.path) } : null
  }
}

/**
 * Each still's photos once filmed (§5, manifest.static_assets), relative to the shoot folder: product
 * photos by channel, avatar photos by person. From the shoot's raw/ listing, relative to raw/.
 */
export function stillAssets(rawRelative: string[]): { product: Record<string, string[]>, avatar: Record<string, string[]> } {
  const product: Record<string, string[]> = {}
  const avatar: Record<string, string[]> = {}
  const image = /\.(jpe?g|png|heic|heif|webp)$/i
  for (const path of [...rawRelative].sort()) {
    if (!image.test(path)) continue
    const parts = path.split('/')
    // <channel>/stills/product/<photo>, <channel>/stills/avatar/<person>/<photo>
    if (parts[1] !== 'stills') continue
    if (parts[2] === 'product' && parts.length === 4) (product[parts[0]!] ??= []).push(`raw/${path}`)
    if (parts[2] === 'avatar' && parts.length === 5) (avatar[parts[3]!] ??= []).push(`raw/${path}`)
  }
  return { product, avatar }
}

// --- Kanvas's index: edited/_kanvas.json ----------------------------------------------------

export const KANVAS_FLAGS = ['generated_product', 'text_mismatch', 'rule_breach', 'composition'] as const
export type KanvasFlag = typeof KANVAS_FLAGS[number]
/** the flags that block a static batch from being submitted until the ad is approved or rejected */
export const BLOCKING_FLAGS: readonly KanvasFlag[] = ['generated_product']
export const KANVAS_FLAG_LABELS: Record<KanvasFlag, string> = {
  generated_product: 'Kanvas drew the product',
  text_mismatch: 'The text isn\'t quite the copy',
  rule_breach: 'May break a rule',
  composition: 'Layout looks off'
}

const KanvasRenderSchema = z.object({
  recipe: z.string(),
  batch: z.string(),
  status: z.enum(['rendered', 'failed']),
  files: z.object({ '1x1': z.string().nullable().optional(), '4x5': z.string().nullable().optional(), '9x16': z.string().nullable().optional() }),
  product: z.enum(['from_still', 'generated', 'none']),
  flags: z.array(z.object({ code: z.enum(KANVAS_FLAGS), size: z.string().optional(), note: z.string() })),
  attempts: z.number().int().nonnegative(),
  model: z.string()
})

export const KanvasIndexSchema = z.object({
  schema_version: z.literal(KANVAS_CONTRACT_VERSION),
  kanvas_version: z.string(),
  plan_hash: z.string(),
  shoot: z.string(),
  updated_at: z.string(),
  assets: z.array(z.object({ file: z.string(), kind: z.enum(['cutout', 'frame']), of: z.string(), person: z.string().optional() })),
  renders: z.array(KanvasRenderSchema)
})
export type KanvasIndex = z.infer<typeof KanvasIndexSchema>
export type KanvasRender = z.infer<typeof KanvasRenderSchema>

/** Kanvas's index, checked against the contract; the error says what's wrong in words. */
export function parseKanvasIndex(json: unknown): { index: KanvasIndex, error?: undefined } | { index?: undefined, error: string } {
  const version = (json as { schema_version?: unknown } | null)?.schema_version
  if (typeof version === 'number' && version !== KANVAS_CONTRACT_VERSION) {
    return { error: `Kanvas wrote contract version ${version}; Kreate reads version ${KANVAS_CONTRACT_VERSION}. Update whichever is behind.` }
  }
  const parsed = KanvasIndexSchema.safeParse(json)
  if (!parsed.success) return { error: `Kanvas's index (edited/_kanvas.json) isn't valid: ${parsed.error.issues[0]?.path.join('.') || 'its shape'} ${parsed.error.issues[0]?.message ?? ''}`.trim() }
  return { index: parsed.data }
}

/** A render's flags that need a person's decision before its batch is submitted. */
export const blockingFlags = (render: Pick<KanvasRender, 'flags'>) => render.flags.filter(flag => (BLOCKING_FLAGS as readonly string[]).includes(flag.code))
