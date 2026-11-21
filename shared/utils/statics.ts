// Static ads (docs/spec-statics.md): the shapes and rules shared by the Library's Statics tab, the
// shoot, the static recipe builder and the AI connector, so each reads and writes them the same way.
// Pure: no database calls here (staticPlan.ts does the writes).
import type { Row } from '../types/models'
import { parseCsv, headerKey } from './brandImport'
import type { SlotContext } from './slots'
import { buildSlotContext, countWords, renderScript } from './slots'
import { parseSlotValues } from './orgProfile'

/** what the AI connector tags its drafts with, until a person saves them */
export const AI_DRAFT_TAG = 'ai-draft'

export const STATIC_VARIANTS = ['text', 'text_product', 'text_avatar', 'text_product_avatar'] as const
export type StaticVariant = typeof STATIC_VARIANTS[number]
export const STATIC_VARIANT_LABELS: Record<StaticVariant, string> = {
  text: 'Text',
  text_product: 'Text + product',
  text_avatar: 'Text + person',
  text_product_avatar: 'Text + product + person'
}
/** what a variant shows besides its copy, so what a recipe needs for it (§2) */
export const variantNeeds = (variant: StaticVariant) => ({ product: variant.includes('product'), avatar: variant.includes('avatar') })

export const STATIC_SIZES = ['4x5', '1x1', '9x16'] as const
export type StaticSize = typeof STATIC_SIZES[number]
export const STATIC_TEXT_RENDERS = ['ai', 'overlay'] as const
export type StaticTextRender = typeof STATIC_TEXT_RENDERS[number]

/** One piece of copy a format takes, in order: a headline, a sub-head, a note's body… */
export interface StaticSlot {
  key: string
  label: string
  max_words: number | null
  guidance: string | null
  example: string | null
  required: boolean
}
export interface StaticRules { always: string[], never: string[] }
/** An example ad in the static-references bucket (<org id>/<format id>/<file>). */
export interface StaticReference { path: string, source_url: string | null }

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter((entry): entry is string => !!entry) : []

/** "Sub head" -> "sub_head": a slot's key, lowercase snake case, starting with a letter. */
export function staticSlotKey(value: string): string {
  const key = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(key) ? key : key ? `slot_${key}` : ''
}

/** A format's slots as stored, read leniently (unknown fields dropped, missing ones defaulted). */
export function parseStaticSlots(value: unknown): StaticSlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const slot = entry as Record<string, unknown>
    const key = text(slot.key) ?? ''
    if (!key) return []
    const words = Number(slot.max_words)
    return [{
      key,
      label: text(slot.label) ?? key.replaceAll('_', ' '),
      max_words: Number.isFinite(words) && words > 0 ? Math.round(words) : null,
      guidance: text(slot.guidance),
      example: text(slot.example),
      required: slot.required !== false
    }]
  })
}

/**
 * Slots ready to save: trimmed, each with a key (from its label when it has none), keys unique.
 * Throws a message a person can act on.
 */
export function cleanStaticSlots(slots: Partial<StaticSlot>[]): StaticSlot[] {
  const out = slots
    .filter(slot => (slot.label ?? '').trim() || (slot.key ?? '').trim())
    .map((slot) => {
      const label = (slot.label ?? '').trim() || (slot.key ?? '').trim().replaceAll('_', ' ')
      const words = Number(slot.max_words)
      return {
        key: staticSlotKey(slot.key?.trim() || label),
        label,
        max_words: Number.isFinite(words) && words > 0 ? Math.round(words) : null,
        guidance: slot.guidance?.trim() || null,
        example: slot.example?.trim() || null,
        required: slot.required !== false
      }
    })
  const seen = new Set<string>()
  for (const slot of out) {
    if (!slot.key) throw new Error(`"${slot.label}" needs a key made of letters.`)
    if (seen.has(slot.key)) throw new Error(`Two slots are called "${slot.key}": give each its own name.`)
    seen.add(slot.key)
  }
  return out
}

export function parseStaticRules(value: unknown): StaticRules {
  const rules = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { always: strings(rules.always), never: strings(rules.never) }
}
/** Rules ready to save: trimmed, blank lines and repeats dropped. */
export function cleanStaticRules(rules: Partial<StaticRules>): StaticRules {
  const clean = (list: string[] = []) => [...new Set(list.map(line => line.trim()).filter(Boolean))]
  return { always: clean(rules.always), never: clean(rules.never) }
}

export function parseStaticReferences(value: unknown): StaticReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const ref = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    const path = text(ref?.path)
    return path ? [{ path, source_url: text(ref?.source_url) }] : []
  })
}

/** Variants in their usual order, known ones only; at least one. */
export function cleanStaticVariants(list: readonly string[]): StaticVariant[] {
  const picked = STATIC_VARIANTS.filter(variant => list.includes(variant))
  if (!picked.length) throw new Error('Pick at least one variant: text, text + product, text + person, or all three.')
  return picked
}
export function cleanStaticSizes(list: readonly string[]): StaticSize[] {
  const picked = STATIC_SIZES.filter(size => list.includes(size))
  if (!picked.length) throw new Error('Pick at least one size.')
  return picked
}

/** The next free static format code: SF01, SF02… */
export function nextStaticFormatCode(codes: readonly string[]): string {
  const highest = Math.max(0, ...codes.map(code => Number(code.match(/^SF(\d+)$/)?.[1] ?? 0)))
  return `SF${String(highest + 1).padStart(2, '0')}`
}

/** A slot's text over its word limit, as a warning (like a VO's length): null when it fits. */
export function slotOverLimit(slot: Pick<StaticSlot, 'max_words'>, value: string): string | null {
  if (!slot.max_words) return null
  const words = countWords(value)
  return words > slot.max_words ? `${words} words, over the ${slot.max_words}-word limit` : null
}

// --- CSV import (§2): one format per row, for a starter library -------------------------------

export interface StaticFormatImport {
  name: string
  description: string | null
  mechanism: string | null
  variants: StaticVariant[]
  rules: StaticRules
  tags: string[]
}

const COLUMNS = {
  name: ['name', 'format', 'format name', 'title'],
  description: ['description', 'what it is', 'what'],
  mechanism: ['mechanism', 'why it works', 'why'],
  variants: ['variants', 'variant', 'variant text', 'variant type', 'type'],
  always: ['always', 'do', 'dos', 'always do'],
  never: ['never', 'don t', 'donts', 'don ts', 'never do'],
  rules: ['rules', 'rule'],
  tags: ['tags', 'tag']
}

/** "text + product", "Text, product & person" → the variant; unknown text → null */
function variantFrom(value: string): StaticVariant | null {
  const words = value.toLowerCase()
  const product = /product/.test(words)
  const avatar = /avatar|person|people|creator|face/.test(words)
  if (!/text|copy|product|avatar|person|people|creator|face/.test(words)) return null
  return product && avatar ? 'text_product_avatar' : product ? 'text_product' : avatar ? 'text_avatar' : 'text'
}
const lines = (value: string) => value.split(/\r?\n|;|•/).map(line => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)

/**
 * Formats from a CSV: a header row, then one format per row. Names are needed; variants default to
 * text. Rules come from Always / Never columns, or a Rules column whose lines start "Never" or
 * "Don't" (the rest count as always). They're imported as drafts with no slots.
 */
export function parseStaticFormatsCsv(csv: string): { formats: StaticFormatImport[], skipped: number } {
  const [header, ...rows] = parseCsv(csv)
  if (!header) return { formats: [], skipped: 0 }
  const keys = header.map(headerKey)
  const column = (names: string[]) => keys.findIndex(key => names.includes(key))
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([field, names]) => [field, column(names)])) as Record<keyof typeof COLUMNS, number>
  if (at.name < 0) throw new Error('The CSV needs a Name column.')
  const cell = (row: string[], index: number) => index >= 0 ? (row[index] ?? '').trim() : ''

  let skipped = 0
  const formats: StaticFormatImport[] = []
  for (const row of rows) {
    const name = cell(row, at.name)
    if (!name) {
      skipped++
      continue
    }
    const variants = [...new Set(cell(row, at.variants).split(/[,|/\n]/).map(variantFrom).filter((variant): variant is StaticVariant => !!variant))]
    const always = lines(cell(row, at.always))
    const never = lines(cell(row, at.never))
    for (const line of lines(cell(row, at.rules))) {
      const negative = line.match(/^(never|don'?t|do not|avoid)\b[:\s-]*(.*)$/i)
      if (negative) never.push(negative[2]!.trim() || line)
      else always.push(line.replace(/^always\b[:\s-]*/i, '').trim() || line)
    }
    formats.push({
      name,
      description: cell(row, at.description) || null,
      mechanism: cell(row, at.mechanism) || null,
      variants: variants.length ? STATIC_VARIANTS.filter(variant => variants.includes(variant)) : ['text'],
      rules: cleanStaticRules({ always, never }),
      tags: cell(row, at.tags).split(/[,;]/).map(tag => tag.trim().toLowerCase()).filter(Boolean)
    })
  }
  return { formats, skipped }
}

// --- brand kits (§3) ---------------------------------------------------------------------------

export const KIT_FONT_ROLES = ['headline', 'body'] as const
export type KitFontRole = typeof KIT_FONT_ROLES[number]
export const KIT_LOGO_USES = ['light', 'dark', 'mark'] as const
export type KitLogoUse = typeof KIT_LOGO_USES[number]
export interface KitColor { name: string, hex: string }
/** a font by family name, or an uploaded file (a path in the brand-kits bucket) for overlay formats */
export interface KitFont { role: KitFontRole, family: string, file: string | null }
export interface KitLogo { path: string, use: KitLogoUse }
export interface BrandKit {
  colors: KitColor[]
  fonts: KitFont[]
  logos: KitLogo[]
  style_notes: string | null
  rules: StaticRules
  dropbox_path: string | null
}

/** The folders in a brand's Dropbox `_kit/` (relative to the UGC root): packshots go here by hand. */
export const BRAND_KIT_FOLDERS = ['logo', 'fonts', 'packshots'] as const
export const brandKitFolder = (brandSlug: string) => `${brandSlug}/_kit`

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
/** "#F60" / "ff6600" → "#ff6600"; null when it isn't a colour */
export function kitHex(value: string): string | null {
  const match = value.trim().match(HEX)
  if (!match) return null
  const digits = match[1]!.toLowerCase()
  return `#${digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits}`
}

/** A brand kit as stored, read leniently; a brand without a kit reads as an empty one. */
export function parseBrandKit(row: {
  colors?: unknown, fonts?: unknown, logos?: unknown, style_notes?: string | null, rules?: unknown, dropbox_path?: string | null
} | null | undefined): BrandKit {
  const entries = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : []
  return {
    colors: entries(row?.colors).flatMap((color) => {
      const hex = typeof color.hex === 'string' ? kitHex(color.hex) : null
      return hex ? [{ name: text(color.name) ?? hex, hex }] : []
    }),
    fonts: entries(row?.fonts).flatMap((font) => {
      const role = KIT_FONT_ROLES.find(entry => entry === font.role)
      const family = text(font.family)
      return role && family ? [{ role, family, file: text(font.file) }] : []
    }),
    logos: entries(row?.logos).flatMap((logo) => {
      const use = KIT_LOGO_USES.find(entry => entry === logo.use) ?? 'light'
      const path = text(logo.path)
      return path ? [{ path, use }] : []
    }),
    style_notes: row?.style_notes?.trim() || null,
    rules: parseStaticRules(row?.rules),
    dropbox_path: row?.dropbox_path ?? null
  }
}

/** Colours ready to save: each a name and a hex colour. Throws on one that isn't a colour. */
export function cleanKitColors(colors: Partial<KitColor>[]): KitColor[] {
  return colors.filter(color => (color.hex ?? '').trim() || (color.name ?? '').trim()).map((color) => {
    const hex = kitHex(color.hex ?? '')
    if (!hex) throw new Error(`"${color.hex || color.name}" isn't a colour: use a hex code like #ff6600.`)
    return { name: color.name?.trim() || hex, hex }
  })
}
/** Fonts ready to save: a role and a family each, at most one per role. */
export function cleanKitFonts(fonts: Partial<KitFont>[]): KitFont[] {
  const out: KitFont[] = []
  for (const font of fonts) {
    const role = KIT_FONT_ROLES.find(entry => entry === font.role)
    const family = font.family?.trim()
    if (!family && !font.file) continue
    if (!role) throw new Error('Each font is for headlines or body text.')
    if (!family) throw new Error(`Name the ${role} font's family (e.g. Inter).`)
    if (out.some(entry => entry.role === role)) throw new Error(`There's already a ${role} font.`)
    out.push({ role, family, file: font.file ?? null })
  }
  return out
}

// --- a shoot's statics (§4, §5) ----------------------------------------------------------------

/** One slot's copy: its first wording and any others (mixed into recipes up to the wording mixes). */
export interface CopySlot { slot: string, text: string, alternates: { text: string }[] }

export function parseCopySlots(value: unknown): CopySlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const slot = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    const key = text(slot?.slot)
    if (!key) return []
    const alternates = Array.isArray(slot?.alternates)
      ? slot.alternates.flatMap((alt) => {
          const value = text((alt as { text?: unknown } | null)?.text)
          return value ? [{ text: value }] : []
        })
      : []
    return [{ slot: key, text: typeof slot?.text === 'string' ? slot.text.trim() : '', alternates }]
  })
}

/**
 * Copy ready to save against its format: the format's slots in its order (others refused), every
 * required one with text, other wordings trimmed, without repeats or one equal to the first.
 */
export function cleanCopySlots(formatSlots: StaticSlot[], input: { slot: string, text?: string | null, alternates?: ({ text?: string | null } | string)[] }[]): CopySlot[] {
  const unknown = input.filter(entry => !formatSlots.some(slot => slot.key === entry.slot)).map(entry => entry.slot)
  if (unknown.length) throw new Error(`The format has no ${unknown.join(', ')} slot${unknown.length === 1 ? '' : 's'}. Its slots are ${formatSlots.map(slot => slot.key).join(', ') || 'not set yet'}.`)
  return formatSlots.flatMap((slot) => {
    const given = input.find(entry => entry.slot === slot.key)
    const first = given?.text?.trim() ?? ''
    if (!first && slot.required) throw new Error(`"${slot.label}" needs copy.`)
    if (!first) return []
    const alternates = [...new Set((given?.alternates ?? [])
      .map(alt => (typeof alt === 'string' ? alt : alt.text ?? '').trim())
      .filter(alt => alt && alt !== first))].map(alt => ({ text: alt }))
    return [{ slot: slot.key, text: first, alternates }]
  })
}

/** What's missing from a copy for its format: required slots without text. */
export function copyGaps(formatSlots: StaticSlot[], copy: CopySlot[]): string[] {
  return formatSlots.filter(slot => slot.required && !copy.find(entry => entry.slot === slot.key)?.text.trim()).map(slot => slot.label)
}

/** The next free copy code on a shoot: A01, A02… */
export function nextStaticCopyCode(codes: readonly string[]): string {
  const highest = Math.max(0, ...codes.map(code => Number(code.match(/^A(\d+)$/)?.[1] ?? 0)))
  return `A${String(highest + 1).padStart(2, '0')}`
}

/** How many wordings a copy can be read in: every combination of its slots' wordings. */
export const copyCombinations = (copy: CopySlot[]) => copy.reduce((total, slot) => total * (1 + slot.alternates.length), 1)

export const STILL_KINDS = ['product', 'avatar'] as const
export type StillKind = typeof STILL_KINDS[number]
/** Which stills a shoot needs from the variants of its static formats. */
export function stillsNeeded(variants: readonly string[]): Record<StillKind, boolean> {
  return {
    product: variants.some(variant => variant.includes('product')),
    avatar: variants.some(variant => variant.includes('avatar'))
  }
}
/**
 * The stills to suggest (§5): a product hero and a product in hand for product variants; a portrait,
 * a person holding the product and, on channels with a dog, the person with the dog, for avatar ones.
 */
export function suggestedStills(kind: StillKind, withDog = false): string[] {
  return kind === 'product'
    ? ['Product hero: the pack on a clean surface, label to camera', 'The product in your hand, label to camera']
    : ['Portrait, face to camera, plain background', 'You holding the product, smiling to camera', ...(withDog ? ['You with your dog, both looking to camera'] : [])]
}
export const MIN_STILL_SHORT_SIDE = 1080

/** A shoot's statics, loaded with it: its static formats, its copy and its stills. */
export interface BundleStatics {
  formats: Row<'static_formats'>[]
  copies: Row<'static_copies'>[]
  stills: Row<'still_shots'>[]
}

/** A copy with its slots filled for one channel ({{brand}}, {{product}}, channel and custom slots). */
export function renderCopy(copy: CopySlot[], context: SlotContext): { slots: { slot: string, text: string, alternates: string[] }[], unfilled: string[] } {
  const unfilled = new Set<string>()
  const fill = (value: string) => {
    const result = renderScript(value, context)
    for (const slot of result.unfilled) unfilled.add(slot)
    return result.text
  }
  return {
    slots: copy.map(slot => ({ slot: slot.slot, text: fill(slot.text), alternates: slot.alternates.map(alt => fill(alt.text)) })),
    unfilled: [...unfilled]
  }
}

interface StaticsBundle {
  shoot: { slot_values?: unknown }
  brand: { name: string }
  product: { name: string }
  channels: { id: string, name: string, slot_values?: unknown }[]
  statics?: BundleStatics
}

/** The channels a copy is for: its cast channel, or every channel on the shoot. */
export const copyChannels = <T extends { id: string }>(channels: T[], copy: Pick<Row<'static_copies'>, 'cast_channel_id'>) =>
  copy.cast_channel_id ? channels.filter(channel => channel.id === copy.cast_channel_id) : channels

/** The slot context for a channel, as scripts fill it. */
export function copyContext(bundle: StaticsBundle, channel: { slot_values?: unknown }): SlotContext {
  return buildSlotContext({
    brand: bundle.brand.name,
    product: bundle.product.name,
    channelValues: parseSlotValues(channel.slot_values),
    slotValues: bundle.shoot.slot_values
  })
}

/** What about a shoot's statics stops it being planned, in words a person can act on. */
export function staticBlockers(bundle: StaticsBundle): string[] {
  const statics = bundle.statics
  if (!statics?.formats.length) return []
  const list: string[] = []
  const bare = statics.formats.filter(format => !statics.copies.some(copy => copy.static_format_id === format.id))
  if (bare.length) list.push(`Write copy for ${bare.map(format => format.code).join(', ')} (Statics)`)
  const gaps = statics.copies.flatMap((copy) => {
    const format = statics.formats.find(entry => entry.id === copy.static_format_id)
    const missing = format ? copyGaps(parseStaticSlots(format.slots), parseCopySlots(copy.slots)) : []
    return missing.length ? [`${copy.code} (${missing.join(', ')})`] : []
  })
  if (gaps.length) list.push(`Fill the required copy in ${gaps.join(', ')}`)
  const unfilled = statics.copies.filter(copy => copyChannels(bundle.channels, copy)
    .some(channel => renderCopy(parseCopySlots(copy.slots), copyContext(bundle, channel)).unfilled.length))
  if (unfilled.length) list.push(`Fill the slots in ${unfilled.map(copy => copy.code).join(', ')} (Statics)`)
  const needs = stillsNeeded(statics.formats.flatMap(format => format.variants))
  if (needs.product && !statics.stills.some(still => still.kind === 'product')) list.push('Add product stills (Statics): a format has a product variant')
  if (needs.avatar && !statics.stills.some(still => still.kind === 'avatar')) list.push('Add avatar stills (Statics): a format has a person variant')
  return list
}
