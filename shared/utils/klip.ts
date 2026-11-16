// Kreate's side of the Kreate ↔ Klip contract (docs/contract.md): take roles, what each treatment
// needs Klip to make (its ingredients, by component), the plan hash, and Klip's index of what it
// made (edited/_klip.json). Pure, shared by the app and the server.

import { z } from 'zod'
import type { BundleItem, BundleTreatment, ShootBundle } from './shootsheet'
import { STANDALONE_CTA_BEAT, STANDALONE_HOOK_BEAT, isStandalone, itemBeats, takeSpot } from './shootsheet'
import { parseTakeKey, slugify } from './slots'
import { sha256Hex } from './sha256'

/** The contract version this code implements (docs/contract.md, top line). */
export const KLIP_CONTRACT_VERSION = 2

// --- takes and their roles (§3) ----------------------------------------------------------

export type TakeRole = 'hook' | 'cta' | 'beat'
export const TAKE_ROLES: TakeRole[] = ['hook', 'cta', 'beat']

/** A take's role, from the plan: a standalone VO's hook and CTA beats count as a hook and a CTA. */
export function takeRole(item: Pick<BundleItem, 'kind' | 'format'>, beat: string | null): TakeRole {
  if (item.kind === 'hook') return 'hook'
  if (item.kind === 'cta') return 'cta'
  const name = beat ? parseTakeKey(beat).beat : ''
  if (isStandalone(item) && name === STANDALONE_HOOK_BEAT) return 'hook'
  if (isStandalone(item) && name === STANDALONE_CTA_BEAT) return 'cta'
  return 'beat'
}

/** Every filmed take in the plan (screen beats have none), with its spot and role. */
export function planTakes(bundle: ShootBundle) {
  return bundle.items.flatMap(item => itemBeats(item).map(beat => ({ item, beat, spot: takeSpot(bundle, item, beat), role: takeRole(item, beat) })))
}

// --- ingredients (§4, §5) ----------------------------------------------------------------

/** A block Klip makes beside a take, other than the clip itself. */
export type Block = 'captions' | 'cutout' | 'captions-retro'
export const BLOCKS: Block[] = ['captions', 'cutout', 'captions-retro']
/** Text Klip writes for a take. */
export type TextIngredient = 'search_query' | 'placed_text'
export type Ingredient = Exclude<Block, 'captions'> | TextIngredient

/** The components the renderer can draw, and what each needs. Anything else can't be drawn. */
export const COMPONENT_INGREDIENTS: Record<string, Ingredient[]> = {
  layout: [],
  search_bar: ['search_query'],
  placed_text: ['placed_text'],
  retro_look: ['captions-retro'],
  greenscreen: ['cutout'],
  picture_in_picture: []
}
export const isTextIngredient = (ingredient: Ingredient): ingredient is TextIngredient =>
  ingredient === 'search_query' || ingredient === 'placed_text'

type TreatmentShape = Pick<BundleTreatment, 'component' | 'placement'> & { parts?: TreatmentShape[] | null }

/** Can the renderer draw it? A combination can when every part can. */
export function isDrawable(treatment: TreatmentShape): boolean {
  if (treatment.component === 'combo') return !!treatment.parts?.length && treatment.parts.every(isDrawable)
  return treatment.component in COMPONENT_INGREDIENTS
}

/** The roles a placement covers: hook, cta, or every take (video). */
export const scopeOf = (placement: string): TakeRole[] =>
  placement === 'hook' ? ['hook'] : placement === 'cta' ? ['cta'] : [...TAKE_ROLES]

/** What a treatment needs, and on which takes: each part's ingredients over that part's scope. */
export function treatmentIngredients(treatment: TreatmentShape): { ingredient: Ingredient, roles: TakeRole[] }[] {
  const parts = treatment.component === 'combo' ? treatment.parts ?? [] : [treatment]
  return parts.flatMap(part => (COMPONENT_INGREDIENTS[part.component] ?? []).map(ingredient => ({ ingredient, roles: scopeOf(part.placement) })))
}

/** Everything a shoot's treatments need of one take, by its role. */
export function ingredientsFor(treatments: TreatmentShape[], role: TakeRole): Ingredient[] {
  return [...new Set(treatments.flatMap(treatment => treatmentIngredients(treatment)
    .filter(need => need.roles.includes(role))
    .map(need => need.ingredient)))]
}

// --- the plan hash (§7) ------------------------------------------------------------------

/**
 * A hash of what Klip works from: every filmed take (spot and role) and the treatments it makes
 * ingredients for. It doesn't change as a shoot is filmed (b-roll shots added, shots ticked off),
 * only when the takes or the treatments do, which means Klip has to run again.
 */
export function planHash(bundle: ShootBundle): string {
  const takes = planTakes(bundle).map(take => `${take.spot}|${take.role}`).sort()
  const treatments = (bundle.treatments ?? []).filter(isDrawable).map(treatment => ({
    slug: slugify(treatment.name),
    component: treatment.component,
    placement: treatment.placement,
    settings: treatment.settings ?? {},
    parts: (treatment.parts ?? []).map(part => ({ component: part.component, placement: part.placement, settings: part.settings ?? {} }))
  })).sort((a, b) => a.slug.localeCompare(b.slug))
  return `sha256:${sha256Hex(JSON.stringify({ takes, treatments }))}`
}

// --- Klip's index: edited/_klip.json (§6) ------------------------------------------------

const nullableNumber = z.number().nonnegative().nullable()

const KlipTakeSchema = z.object({
  spot: z.string(),
  raw_file: z.string(),
  role: z.enum(['hook', 'cta', 'beat']),
  status: z.enum(['edited', 'failed']),
  files: z.object({
    clip: z.string().nullable(),
    captions: z.string().nullable(),
    cutout: z.string().nullable().optional(),
    'captions-retro': z.string().nullable().optional()
  }),
  duration: nullableNumber,
  frames: nullableNumber,
  fps: nullableNumber,
  text: z.object({
    search_query: z.string().optional(),
    placed_text: z.object({ text: z.string(), x: z.number(), y: z.number() }).optional()
  }).optional(),
  review: z.object({ needed: z.boolean(), reasons: z.array(z.string()), notes: z.array(z.string()) })
})

const KlipBrollSchema = z.object({
  file: z.string().nullable(),
  raw_file: z.string(),
  status: z.enum(['edited', 'failed']),
  duration: nullableNumber,
  frames: nullableNumber,
  fps: nullableNumber
})

export const KlipIndexSchema = z.object({
  schema_version: z.literal(KLIP_CONTRACT_VERSION),
  klip_version: z.string(),
  plan_hash: z.string(),
  shoot: z.string(),
  updated_at: z.string(),
  complete: z.boolean(),
  takes: z.array(KlipTakeSchema),
  broll: z.array(KlipBrollSchema),
  unknown: z.array(z.object({ raw_file: z.string(), reason: z.enum(['duplicate', 'no spot']) }))
})

export type KlipIndex = z.infer<typeof KlipIndexSchema>
export type KlipTake = z.infer<typeof KlipTakeSchema>
export type KlipBroll = z.infer<typeof KlipBrollSchema>

/**
 * Read edited/_klip.json. A schema version this code doesn't know is refused with a clear message,
 * never guessed at (§9).
 */
export function parseKlipIndex(json: unknown): { index: KlipIndex, error?: undefined } | { index?: undefined, error: string } {
  const version = (json as { schema_version?: unknown } | null)?.schema_version
  if (version !== KLIP_CONTRACT_VERSION) {
    return { error: `Klip's index (edited/_klip.json) is contract version ${String(version ?? 'unknown')}; Kreate reads version ${KLIP_CONTRACT_VERSION}. Update Klip or Kreate so they match.` }
  }
  const parsed = KlipIndexSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { error: `Klip's index (edited/_klip.json) isn't valid: ${issue ? `${issue.path.join('.') || 'the file'} ${issue.message}` : 'unreadable'}` }
  }
  return { index: parsed.data }
}

/** A take's blocks other than its clip, as the manifest and recipes carry them. */
export type TakeBlocks = Partial<Record<Block, string | null>> & { captions: string | null }
/** A take's text ingredients, as Klip wrote them. */
export type TakeText = NonNullable<KlipTake['text']>

/** Does an indexed take have this ingredient? */
export function hasIngredient(take: { blocks?: TakeBlocks | null, text?: TakeText | null }, ingredient: Ingredient): boolean {
  if (isTextIngredient(ingredient)) return !!take.text?.[ingredient]
  return !!take.blocks?.[ingredient]
}
