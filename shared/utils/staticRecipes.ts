// Static recipes (docs/spec-statics.md §6, docs/contract-kanvas.md): every static ad a Live shoot can
// make, built from its manifest, and the static batch loop (§7). Kreate decides which ads exist;
// Kanvas makes them. Pure and deterministic: the same manifest makes the same recipes and IDs.
import type { ElementRecord } from './batchLoop'
import { DEFAULT_EXPLOIT_SHARE, elementState } from './batchLoop'
import type { PlanStatic } from './kanvas'
import { buildStaticPlan } from './kanvas'
import { batchSize, hash, pickCombos } from './recipes'
import type { StaticSize, StaticVariant } from './statics'
import { variantNeeds } from './statics'

export const STATICS_SCHEMA_VERSION = 1

export interface StaticRecipe {
  /** e.g. S001_topdognix_SF03.text_product_A02.1.2_<hash of the picks>; a person variant adds the person after the channel */
  id: string
  channel: string
  /** the person in a person variant (null for text and text + product) */
  person: string | null
  format: string
  variant: StaticVariant
  /** the copy: which wording of each slot (1 = the first), and the final text of each, filled for the channel */
  copy: { code: string, wordings: number[], slots: Record<string, string> }
  /**
   * The photos picked, relative to the shoot folder: product stills (none: Kanvas draws the
   * product, flagged for approval), and the person (an avatar still, or a hook or CTA take in edited/
   * for Kanvas to take a frame from)
   */
  assets: { product?: string[], avatar?: string[] }
  sizes: StaticSize[]
}

/** What static recipes are built from: a Live manifest's, or a shoot's plan for estimates. */
export interface StaticRecipeInput {
  shoot: string
  plan: PlanStatic
  /** each channel's slug with the people on it (slugs) */
  channels: { slug: string, people: string[] }[]
  /** product stills by channel, relative to the shoot folder */
  productPhotos: Record<string, string[]>
  /** what can show each person on each channel ("<channel>|<person>"): avatar stills, else their hook and CTA takes */
  avatars: Record<string, string[]>
}

const shortHash = (text: string) => hash(text).toString(16).padStart(8, '0')
/** "A02" for the first wordings, "A02.1.2" otherwise: the copy as an element, and in IDs */
export const copyKey = (copy: StaticRecipe['copy']) => copy.wordings.some(option => option > 1) ? `${copy.code}.${copy.wordings.join('.')}` : copy.code

/**
 * Every valid static recipe (§6): one format, one variant, one copy (one wording of each slot), for
 * one channel. A variant is made where its ingredients are: text always; with the product always
 * (with the channel's product stills when there are any); with a person once per person on the
 * channel who has an avatar still or a filmed hook or CTA. A copy with other wordings makes up to the
 * shoot's wording mixes more, each a different combination. Photos are picked in a fixed order,
 * varied across recipes.
 */
export function buildStaticRecipes(input: StaticRecipeInput): StaticRecipe[] {
  const recipes: StaticRecipe[] = []
  for (const channel of [...input.channels].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const products = input.productPhotos[channel.slug] ?? []
    let productTurn = 0
    const avatarTurns = new Map<string, number>()
    for (const copy of input.plan.copies) {
      if (copy.channel && copy.channel !== channel.slug) continue
      const filled = copy.filled[channel.slug]
      const format = input.plan.formats.find(entry => entry.code === copy.format)
      if (!filled || !format) continue
      // the first wordings, then the mixes
      const sizes = filled.map(slot => 1 + slot.alternates.length)
      const wordingSets = [filled.map(() => 1), ...pickCombos(sizes, input.plan.wording_variations, `${input.shoot}|${channel.slug}|${copy.code}`).map(combo => combo.map(index => index + 1))]
      for (const wordings of wordingSets) {
        const slots = Object.fromEntries(filled.map((slot, index) => [slot.slot, wordings[index] === 1 ? slot.text : slot.alternates[wordings[index]! - 2] ?? slot.text]))
        const copyRef = { code: copy.code, wordings, slots }
        for (const variant of format.variants) {
          const needs = variantNeeds(variant)
          const people = needs.avatar ? channel.people.filter(person => (input.avatars[`${channel.slug}|${person}`] ?? []).length) : [null]
          for (const person of people) {
            const assets: StaticRecipe['assets'] = {}
            if (needs.product && products.length) assets.product = [products[productTurn++ % products.length]!]
            if (person) {
              const sources = input.avatars[`${channel.slug}|${person}`]!
              const turn = avatarTurns.get(person) ?? 0
              avatarTurns.set(person, turn + 1)
              assets.avatar = [sources[turn % sources.length]!]
            }
            const id = [input.shoot, channel.slug, ...(person ? [person] : []), `${format.code}.${variant}`, copyKey(copyRef), shortHash(JSON.stringify(assets))].join('_')
            recipes.push({ id, channel: channel.slug, person, format: format.code, variant, copy: copyRef, assets, sizes: format.sizes })
          }
        }
      }
    }
  }
  return recipes
}

/** The input from a Live manifest: its static plan, and the stills and takes Klip and the checklist filed. */
export function staticInputFromManifest(manifest: {
  plan: { shoot: { code: string }, people: { slug: string, channels: string[] }[], channels: { slug: string }[], static?: PlanStatic | null }
  static_assets?: { product: Record<string, string[]>, avatar: Record<string, string[]> }
  clips: { kind: string, channel: string, person?: string, file?: string, option?: number | null }[]
}): StaticRecipeInput | null {
  const plan = manifest.plan.static
  if (!plan) return null
  const assets = manifest.static_assets ?? { product: {}, avatar: {} }
  const channels = manifest.plan.channels.map(channel => ({
    slug: channel.slug,
    people: manifest.plan.people.filter(person => person.channels.includes(channel.slug)).map(person => person.slug)
  }))
  const avatars: Record<string, string[]> = {}
  for (const channel of channels) {
    for (const person of channel.people) {
      const stills = assets.avatar[person] ?? []
      // no avatar still: a frame from their hooks and CTAs on this channel (first wordings), in edited/
      const takes = manifest.clips
        .filter(clip => (clip.kind === 'hook' || clip.kind === 'cta') && clip.channel === channel.slug && clip.person === person && clip.file && !(clip.option && clip.option > 1))
        .map(clip => `edited/${clip.file}`)
        .sort()
      avatars[`${channel.slug}|${person}`] = stills.length ? stills : takes
    }
  }
  return { shoot: manifest.plan.shoot.code, plan, channels, productPhotos: assets.product, avatars }
}

// --- the static batch loop (§7) ----------------------------------------------------------------

/** Static elements, most important first. The person in a person variant is an "avatar" (video's "person" is its own). */
export const STATIC_ELEMENT_KINDS = ['static_format', 'variant', 'static_copy', 'avatar'] as const
export type StaticElementKind = typeof STATIC_ELEMENT_KINDS[number]
export const STATIC_ELEMENT_LABELS: Record<StaticElementKind, string> = {
  static_format: 'Static formats', variant: 'Variants', static_copy: 'Copy', avatar: 'People'
}
/** format and variant count double, as treatments, hooks and formats do for video */
const WEIGHT: Record<StaticElementKind, number> = { static_format: 2, variant: 2, static_copy: 1, avatar: 1 }

export function staticRecipeElements(recipe: StaticRecipe): { kind: StaticElementKind, key: string }[] {
  return [
    { kind: 'static_format', key: recipe.format },
    { kind: 'variant', key: recipe.variant },
    { kind: 'static_copy', key: copyKey(recipe.copy) },
    ...(recipe.person ? [{ kind: 'avatar' as const, key: recipe.person }] : [])
  ]
}
export function staticBatchElements(recipes: StaticRecipe[]) {
  const seen = new Map<string, { kind: StaticElementKind, key: string }>()
  for (const recipe of recipes) for (const element of staticRecipeElements(recipe)) seen.set(`${element.kind}:${element.key}`, element)
  return [...seen.values()].sort((a, b) =>
    STATIC_ELEMENT_KINDS.indexOf(a.kind) - STATIC_ELEMENT_KINDS.indexOf(b.kind) || a.key.localeCompare(b.key, 'en', { numeric: true }))
}

/**
 * Choose a static batch, one recipe at a time (Best in Show): no two share a format + copy pair; then
 * the least-used variant, person and format first; ties on a stable hash.
 */
export function chooseStaticBatch(recipes: StaticRecipe[], options: { size: number, prefer?: (recipe: StaticRecipe) => number, after?: StaticRecipe[] }): StaticRecipe[] {
  const used = new Map<string, number>()
  const count = (key: string) => used.get(key) ?? 0
  const pairs = new Set<string>()
  const pair = (recipe: StaticRecipe) => `${recipe.format}|${recipe.copy.code}`
  const take = (recipe: StaticRecipe) => {
    pairs.add(pair(recipe))
    for (const key of [`variant:${recipe.variant}`, `person:${recipe.person ?? ''}`, `format:${recipe.format}`, `channel:${recipe.channel}`]) used.set(key, count(key) + 1)
  }
  for (const recipe of options.after ?? []) take(recipe)
  const taken = new Set((options.after ?? []).map(recipe => recipe.id))
  const score = (recipe: StaticRecipe) => [
    options.prefer?.(recipe) ?? 0,
    count(`variant:${recipe.variant}`),
    count(`person:${recipe.person ?? ''}`),
    count(`format:${recipe.format}`),
    count(`channel:${recipe.channel}`),
    hash(recipe.id)
  ]
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
    return false
  }
  const chosen: StaticRecipe[] = []
  while (chosen.length < options.size) {
    let best: StaticRecipe | null = null
    let bestScore: number[] = []
    for (const recipe of recipes) {
      if (taken.has(recipe.id) || pairs.has(pair(recipe))) continue
      const s = score(recipe)
      if (!best || better(s, bestScore)) {
        best = recipe
        bestScore = s
      }
    }
    if (!best) break
    chosen.push(best)
    taken.add(best.id)
    take(best)
  }
  return chosen
}

/**
 * The next static batch (§7), as video's: dropped elements are left out; once something has won,
 * the exploit share goes to recipes with the most (weighted) winning elements and the rest to the
 * most untried; topped up from the rest if either runs short. Nothing is batched twice.
 */
export function pickStaticBatch(recipes: StaticRecipe[], options: { size: number, exclude?: Set<string>, exploitShare?: number, records?: Map<string, ElementRecord> }) {
  const records = options.records ?? new Map<string, ElementRecord>()
  const stateOf = (element: { kind: string, key: string }) => elementState(records.get(`${element.kind}:${element.key}`))
  const open = recipes.filter(recipe => !options.exclude?.has(recipe.id))
  const available = open.filter(recipe => !staticRecipeElements(recipe).some(element => stateOf(element) === 'dropped'))
  const dropped = open.length - available.length
  const weigh = (recipe: StaticRecipe, state: ReturnType<typeof elementState>) =>
    staticRecipeElements(recipe).filter(element => stateOf(element) === state).reduce((sum, element) => sum + WEIGHT[element.kind], 0)

  const anyWinner = [...records.values()].some(record => record.winners > 0 && !record.dropped)
  if (!anyWinner) {
    const chosen = chooseStaticBatch(available, { size: options.size })
    return { recipes: chosen, exploit: 0, explore: chosen.length, dropped }
  }
  const share = Math.min(1, Math.max(0, options.exploitShare ?? DEFAULT_EXPLOIT_SHARE))
  const exploit = chooseStaticBatch(available.filter(recipe => weigh(recipe, 'winner') > 0), { size: Math.round(options.size * share), prefer: recipe => -weigh(recipe, 'winner') })
  const taken = new Set(exploit.map(recipe => recipe.id))
  const explore = chooseStaticBatch(available.filter(recipe => !taken.has(recipe.id) && weigh(recipe, 'untried') > 0), { size: options.size - exploit.length, prefer: recipe => -weigh(recipe, 'untried'), after: exploit })
  const chosen = [...exploit, ...explore]
  if (chosen.length < options.size) {
    const used = new Set(chosen.map(recipe => recipe.id))
    chosen.push(...chooseStaticBatch(available.filter(recipe => !used.has(recipe.id)), { size: options.size - chosen.length, after: chosen }))
  }
  return { recipes: chosen, exploit: exploit.length, explore: chosen.length - exploit.length, dropped }
}

/** SB01, SB02…: the next static batch code. */
export function nextStaticBatchCode(existing: string[]) {
  const n = Math.max(0, ...existing.map(code => Number(code.match(/^SB(\d+)$/)?.[1] ?? 0))) + 1
  return `SB${String(n).padStart(2, '0')}`
}

/** A static batch as it's written: grouped by channel, in pick order within each. */
export function staticBatchOrder(chosen: StaticRecipe[]) {
  const channels = [...new Set(chosen.map(recipe => recipe.channel))].sort((a, b) => a.localeCompare(b))
  return channels.flatMap(channel => chosen.filter(recipe => recipe.channel === channel))
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
/** One row per static recipe in a batch, for people. */
export function staticBatchCsv(recipes: StaticRecipe[]) {
  const rows: unknown[][] = [['recipe', 'channel', 'person', 'format', 'variant', 'copy', 'text', 'product photo', 'person photo']]
  for (const recipe of recipes) {
    rows.push([recipe.id, recipe.channel, recipe.person ?? '', recipe.format, recipe.variant, copyKey(recipe.copy), Object.values(recipe.copy.slots).join(' / '), recipe.assets.product?.join(' ') ?? '', recipe.assets.avatar?.join(' ') ?? ''])
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\n')
}

/** statics.json: every valid static recipe, grouped by channel (docs/contract-kanvas.md). */
export function staticsFile(input: { shoot: string, manifestVersion: number, generatedAt: string, planHash: string | undefined, recipes: StaticRecipe[] }) {
  const channels: Record<string, StaticRecipe[]> = {}
  for (const recipe of input.recipes) (channels[recipe.channel] ??= []).push(recipe)
  return {
    schema_version: STATICS_SCHEMA_VERSION,
    shoot: input.shoot,
    manifest_version: input.manifestVersion,
    generated_at: input.generatedAt,
    plan_hash: input.planHash ?? null,
    // asset paths are relative to the shoot folder; formats and the brand kit are in manifest.json → plan.static
    channels
  }
}

/**
 * The static ads a shoot will make, estimated before it's filmed (the calculator's Statics line):
 * planned stills are taken as filmed, and anyone with a hook or CTA on a channel (or avatar stills
 * planned) can be shown there. Counted per channel, with a static batch's size.
 */
export function estimateStatics(bundle: {
  shoot: { code: string, slot_values?: unknown, static_wording_variations?: number, static_submission_rate?: number }
  brand: { name: string }
  product: { name: string }
  channels: { id: string, name: string, slug: string, slot_values?: unknown }[]
  people: { id: string, slug: string }[]
  channelPeople?: Record<string, string[]>
  items: { kind: string, person_id: string | null, channel_id: string | null, status?: string }[]
  statics?: Parameters<typeof buildStaticPlan>[0]['statics']
}): { recipes: number, perChannel: { name: string, recipes: number }[], batch: number } | null {
  const plan = buildStaticPlan(bundle)
  if (!plan) return null
  const stills = bundle.statics?.stills.filter(still => still.status !== 'skipped') ?? []
  const avatarStills = stills.some(still => still.kind === 'avatar')
  const productStills = stills.some(still => still.kind === 'product')
  const channels = bundle.channels.map(channel => ({
    slug: channel.slug,
    people: bundle.people.filter(person => bundle.channelPeople?.[channel.id]?.includes(person.id)).map(person => person.slug)
  }))
  const avatars: Record<string, string[]> = {}
  for (const channel of bundle.channels) {
    for (const person of bundle.people) {
      const filmsHere = bundle.items.some(item => (item.kind === 'hook' || item.kind === 'cta') && item.person_id === person.id && item.channel_id === channel.id && item.status !== 'skipped')
      if (avatarStills || filmsHere) avatars[`${channel.slug}|${person.slug}`] = ['planned']
    }
  }
  const recipes = buildStaticRecipes({
    shoot: bundle.shoot.code,
    plan,
    channels,
    productPhotos: productStills ? Object.fromEntries(bundle.channels.map(channel => [channel.slug, ['planned']])) : {},
    avatars
  })
  return {
    recipes: recipes.length,
    perChannel: bundle.channels.map(channel => ({ name: channel.name, recipes: recipes.filter(recipe => recipe.channel === channel.slug).length })),
    batch: batchSize(recipes.length, Number(bundle.shoot.static_submission_rate ?? 0.05))
  }
}
