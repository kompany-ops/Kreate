// Static ads: the writes the app and the AI connector share (docs/spec-statics.md §9 parity),
// always with the caller's own Supabase client, so RLS and the database's rules apply.
// Library: static formats and their example ads (references).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../types/database.types'
import type { Row } from '../types/models'
import type { LoadedShoot } from './loadShoot'
import type { PlanStatic } from './kanvas'
import type { KitColor, KitFont, KitLogo, StaticReference, StaticRules, StaticSlot, StillKind } from './statics'
import {
  cleanCopySlots, cleanKitColors, cleanKitFonts, cleanStaticRules, cleanStaticSizes, cleanStaticSlots, cleanStaticVariants, KIT_LOGO_USES,
  nextStaticCopyCode, nextStaticFormatCode, parseBrandKit, parseStaticReferences, parseStaticSlots, STATIC_TEXT_RENDERS, STILL_KINDS,
  stillsNeeded, suggestedStills
} from './statics'
import { parseSlotValues } from './orgProfile'

type Db = SupabaseClient<Database>

function check<T>(result: { data: T, error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
/** A single row that must be there (RLS hides what you can't change, which reads as missing). */
function one<T>(result: { data: T, error: { message: string } | null }, what = 'That'): NonNullable<T> {
  const row = check(result)
  if (!row) throw new Error(`${what} isn't there, or you can't change it.`)
  return row
}

export const STATIC_REFERENCES_BUCKET = 'static-references'
/** An example ad's file types (a flattened PSD, Figma or Canva export is a PNG, JPG or PDF). */
export const STATIC_REFERENCE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf'
}
export const MAX_STATIC_REFERENCE_BYTES = 20 * 1024 * 1024

/** Everything a static format has that a person (or the AI) can set. Missing fields stay as they are. */
export interface StaticFormatInput {
  code?: string
  name?: string
  description?: string | null
  mechanism?: string | null
  slots?: Partial<StaticSlot>[]
  variants?: string[]
  rules?: Partial<StaticRules>
  plate?: boolean
  text_render?: string
  sizes?: string[]
  tags?: string[]
  notes?: string | null
  archived?: boolean
  /** the references to keep, in order (new files are added with addStaticReference) */
  reference_images?: StaticReference[]
}

/** The columns for a static format from what was given, checked: a message a person can act on when it's wrong. */
export function staticFormatFields(input: StaticFormatInput) {
  const fields: Partial<Row<'static_formats'>> = {}
  if (input.code !== undefined) {
    const code = input.code.trim().toUpperCase()
    if (!/^SF\d{2,}$/.test(code)) throw new Error('A static format\'s code is SF and a number, e.g. SF04.')
    fields.code = code
  }
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error('A static format needs a name.')
    fields.name = input.name.trim()
  }
  if (input.description !== undefined) fields.description = input.description?.trim() || null
  if (input.mechanism !== undefined) fields.mechanism = input.mechanism?.trim() || null
  if (input.slots !== undefined) fields.slots = cleanStaticSlots(input.slots) as unknown as Json
  if (input.variants !== undefined) fields.variants = cleanStaticVariants(input.variants)
  if (input.rules !== undefined) fields.rules = cleanStaticRules(input.rules) as unknown as Json
  if (input.plate !== undefined) fields.plate = input.plate
  if (input.text_render !== undefined) {
    if (!(STATIC_TEXT_RENDERS as readonly string[]).includes(input.text_render)) throw new Error('Text is drawn by the AI ("ai") or set over the image ("overlay").')
    fields.text_render = input.text_render
  }
  if (input.sizes !== undefined) fields.sizes = cleanStaticSizes(input.sizes)
  if (input.tags !== undefined) fields.tags = [...new Set(input.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  if (input.notes !== undefined) fields.notes = input.notes?.trim() || null
  if (input.archived !== undefined) fields.archived = input.archived
  if (input.reference_images !== undefined) fields.reference_images = parseStaticReferences(input.reference_images) as unknown as Json
  return fields
}

/**
 * Add a static format (the next SF## unless a code is given), or change one by id. Returns the row.
 * References removed from the list have their files deleted.
 */
export async function saveStaticFormat(db: Db, input: StaticFormatInput, id?: string): Promise<Row<'static_formats'>> {
  const fields = staticFormatFields(input)
  if (id) {
    const before = one(await db.from('static_formats').select('reference_images').eq('id', id).maybeSingle(), 'That static format')
    const row = one(await db.from('static_formats').update(fields).eq('id', id).select('*').maybeSingle(), 'That static format')
    if (fields.reference_images !== undefined) {
      const kept = new Set(parseStaticReferences(row.reference_images).map(ref => ref.path))
      const gone = parseStaticReferences(before.reference_images).map(ref => ref.path).filter(path => !kept.has(path))
      if (gone.length) await db.storage.from(STATIC_REFERENCES_BUCKET).remove(gone)
    }
    return row
  }
  if (!fields.name) throw new Error('A static format needs a name.')
  if (!fields.code) {
    const codes = (check(await db.from('static_formats').select('code')) ?? []).map(row => row.code)
    fields.code = nextStaticFormatCode(codes)
  }
  return one(await db.from('static_formats').insert({ ...fields, name: fields.name, code: fields.code }).select('*').single(), 'The new static format')
}

/**
 * Store an example ad for a format and add it to the end of its references. `file` is the image
 * (or PDF) itself; `type` its media type.
 */
export async function addStaticReference(
  db: Db,
  format: Pick<Row<'static_formats'>, 'id' | 'org_id'>,
  file: Blob,
  type: string,
  sourceUrl: string | null = null
): Promise<StaticReference> {
  const ext = STATIC_REFERENCE_TYPES[type]
  if (!ext) throw new Error('An example ad is a PNG, JPG, WebP, GIF or PDF (export a PSD, Figma or Canva design as one of those).')
  if (file.size > MAX_STATIC_REFERENCE_BYTES) throw new Error('An example ad can be up to 20 MB.')
  const path = `${format.org_id}/${format.id}/${crypto.randomUUID()}.${ext}`
  const { error } = await db.storage.from(STATIC_REFERENCES_BUCKET).upload(path, file, { contentType: type, cacheControl: '3600' })
  if (error) throw new Error(error.message)
  const current = one(await db.from('static_formats').select('reference_images').eq('id', format.id).maybeSingle(), 'That static format')
  const reference: StaticReference = { path, source_url: sourceUrl?.trim() || null }
  check(await db.from('static_formats')
    .update({ reference_images: [...parseStaticReferences(current.reference_images), reference] as unknown as Json })
    .eq('id', format.id))
  return reference
}

/** Signed links to references (private files), path → link, for showing them or handing them to Kanvas or an AI. */
export async function signedStaticReferences(db: Db, paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {}
  const { data, error } = await db.storage.from(STATIC_REFERENCES_BUCKET).createSignedUrls(paths, seconds)
  if (error) throw new Error(error.message)
  return Object.fromEntries((data ?? []).flatMap(entry => entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : []))
}

// --- brand kits (§3) ---------------------------------------------------------------------------

export const BRAND_KITS_BUCKET = 'brand-kits'
/** what a logo or font file can be: its media type from its extension (fonts often come with none) */
export const BRAND_KIT_FILE_TYPES: Record<'logos' | 'fonts', Record<string, string>> = {
  logos: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' },
  fonts: { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }
}
export const MAX_BRAND_KIT_FILE_BYTES = 10 * 1024 * 1024

export interface BrandKitInput {
  colors?: Partial<KitColor>[]
  fonts?: Partial<KitFont>[]
  logos?: KitLogo[]
  style_notes?: string | null
  rules?: Partial<StaticRules>
}

/**
 * Set a brand's design kit (made the first time). Only what's given changes. Logo and font files
 * no longer in the kit are deleted.
 */
export async function saveBrandKit(db: Db, brandId: string, input: BrandKitInput) {
  const fields: Record<string, unknown> = {}
  if (input.colors !== undefined) fields.colors = cleanKitColors(input.colors)
  if (input.fonts !== undefined) fields.fonts = cleanKitFonts(input.fonts)
  if (input.logos !== undefined) {
    fields.logos = input.logos.filter(logo => logo.path).map(logo => ({ path: logo.path, use: KIT_LOGO_USES.includes(logo.use) ? logo.use : 'light' }))
  }
  if (input.style_notes !== undefined) fields.style_notes = input.style_notes?.trim() || null
  if (input.rules !== undefined) fields.rules = cleanStaticRules(input.rules)
  const before = parseBrandKit(check(await db.from('brand_kits').select('*').eq('brand_id', brandId).maybeSingle()))
  const row = one(await db.from('brand_kits').upsert({ brand_id: brandId, ...fields } as never, { onConflict: 'brand_id' }).select('*').maybeSingle(), 'That brand')
  const after = parseBrandKit(row)
  const kept = new Set([...after.logos.map(logo => logo.path), ...after.fonts.map(font => font.file).filter(Boolean)])
  const gone = [...before.logos.map(logo => logo.path), ...before.fonts.flatMap(font => font.file ? [font.file] : [])].filter(path => !kept.has(path))
  if (gone.length) await db.storage.from(BRAND_KITS_BUCKET).remove(gone)
  return row
}

/** Store a logo or font file for a brand's kit; returns its path (add it to the kit with saveBrandKit). */
export async function uploadBrandKitFile(db: Db, brand: { id: string, org_id: string }, kind: 'logos' | 'fonts', file: Blob, name: string): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const type = BRAND_KIT_FILE_TYPES[kind][ext]
  if (!type) throw new Error(kind === 'logos' ? 'A logo is a PNG, JPG, WebP or SVG.' : 'A font file is TTF, OTF, WOFF or WOFF2.')
  if (file.size > MAX_BRAND_KIT_FILE_BYTES) throw new Error('A kit file can be up to 10 MB.')
  const path = `${brand.org_id}/${brand.id}/${kind}/${crypto.randomUUID()}.${ext}`
  const { error } = await db.storage.from(BRAND_KITS_BUCKET).upload(path, file, { contentType: type, cacheControl: '3600' })
  if (error) throw new Error(error.message)
  return path
}

/** Signed links to kit files, path → link. */
export async function signedBrandKitFiles(db: Db, paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {}
  const { data, error } = await db.storage.from(BRAND_KITS_BUCKET).createSignedUrls(paths, seconds)
  if (error) throw new Error(error.message)
  return Object.fromEntries((data ?? []).flatMap(entry => entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : []))
}

// --- a shoot's statics (§4, §5) ---------------------------------------------------------------

function requireDraft(bundle: LoadedShoot, what: string) {
  if (bundle.shoot.status !== 'draft') throw new Error(`The shoot is planned: put it back to draft to change ${what}.`)
}
const staticsOf = (bundle: LoadedShoot) => bundle.statics ?? { formats: [], copies: [], stills: [] }

/**
 * Add static formats to a draft shoot. The first format needing product or avatar stills adds the
 * suggested stills for it (§5), if the shoot has none of that kind yet. Returns how many were added.
 */
export async function addShootStaticFormats(db: Db, bundle: LoadedShoot, formatIds: string[]): Promise<number> {
  requireDraft(bundle, 'its static formats')
  const statics = staticsOf(bundle)
  const fresh = [...new Set(formatIds)].filter(id => !statics.formats.some(format => format.id === id))
  if (!fresh.length) return 0
  const rows = check(await db.from('static_formats').select('id, variants, archived').in('id', fresh)) ?? []
  if (rows.some(row => row.archived)) throw new Error('Archived static formats can\'t be added to a shoot.')
  if (rows.length < fresh.length) throw new Error('One of those static formats isn\'t in this organisation.')
  check(await db.from('shoot_static_formats').insert(fresh.map(id => ({ shoot_id: bundle.shoot.id, static_format_id: id }))))

  const before = stillsNeeded(statics.formats.flatMap(format => format.variants))
  const after = stillsNeeded([...statics.formats.flatMap(format => format.variants), ...rows.flatMap(row => row.variants)])
  const withDog = bundle.channels.some(channel => !!parseSlotValues(channel.slot_values).dog)
  const suggestions = STILL_KINDS
    .filter(kind => after[kind] && !before[kind] && !statics.stills.some(still => still.kind === kind))
    .flatMap(kind => suggestedStills(kind, withDog).map(description => ({ kind, description })))
  if (suggestions.length) await addStillShots(db, bundle, suggestions)
  return fresh.length
}

/** Take a static format off a draft shoot, with the copy written for it. */
export async function removeShootStaticFormat(db: Db, bundle: LoadedShoot, formatId: string) {
  requireDraft(bundle, 'its static formats')
  check(await db.from('shoot_static_formats').delete().eq('shoot_id', bundle.shoot.id).eq('static_format_id', formatId))
}

export interface StaticCopyInput {
  static_format_id?: string
  slots?: { slot: string, text?: string | null, alternates?: ({ text?: string | null } | string)[] }[]
  feature_id?: string | null
  person_id?: string | null
  cast_channel_id?: string | null
  tags?: string[]
  notes?: string | null
}

/** Write static copy for one of the shoot's static formats (the next A## code), or change it by id. */
export async function saveStaticCopy(db: Db, bundle: LoadedShoot, input: StaticCopyInput, id?: string): Promise<Row<'static_copies'>> {
  requireDraft(bundle, 'its static copy')
  const statics = staticsOf(bundle)
  const existing = id ? statics.copies.find(copy => copy.id === id) : undefined
  if (id && !existing) throw new Error('That copy isn\'t on this shoot.')
  const format = statics.formats.find(entry => entry.id === (input.static_format_id ?? existing?.static_format_id))
  if (!format) throw new Error('Add the static format to the shoot first.')
  const fields: Partial<Row<'static_copies'>> = {}
  if (input.static_format_id !== undefined) fields.static_format_id = format.id
  if (input.slots !== undefined) fields.slots = cleanCopySlots(parseStaticSlots(format.slots), input.slots) as unknown as Json
  if (input.feature_id !== undefined) fields.feature_id = input.feature_id
  if (input.person_id !== undefined) fields.person_id = input.person_id
  if (input.cast_channel_id !== undefined) fields.cast_channel_id = input.cast_channel_id
  if (input.tags !== undefined) fields.tags = [...new Set(input.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  if (input.notes !== undefined) fields.notes = input.notes?.trim() || null
  if (existing) return one(await db.from('static_copies').update(fields).eq('id', existing.id).select('*').maybeSingle(), 'That copy')
  return one(await db.from('static_copies').insert({
    ...fields,
    slots: fields.slots ?? cleanCopySlots(parseStaticSlots(format.slots), []) as unknown as Json,
    shoot_id: bundle.shoot.id,
    static_format_id: format.id,
    product_id: bundle.product.id,
    code: nextStaticCopyCode(statics.copies.map(copy => copy.code)),
    sort_order: statics.copies.length
  }).select('*').single(), 'The new copy')
}

export async function removeStaticCopy(db: Db, bundle: LoadedShoot, id: string) {
  requireDraft(bundle, 'its static copy')
  check(await db.from('static_copies').delete().eq('id', id))
}

export interface StillShotInput { kind?: StillKind, description?: string, feature_id?: string | null, count?: number }

/** Add stills to a draft shoot's list. */
export async function addStillShots(db: Db, bundle: LoadedShoot, shots: StillShotInput[]) {
  requireDraft(bundle, 'its stills')
  const start = staticsOf(bundle).stills.length
  const rows = shots.map((shot, index) => {
    if (!shot.kind || !STILL_KINDS.includes(shot.kind)) throw new Error('A still is of the product or of a person (avatar).')
    if (!shot.description?.trim()) throw new Error('Describe each still.')
    return {
      shoot_id: bundle.shoot.id,
      kind: shot.kind,
      description: shot.description.trim(),
      feature_id: shot.kind === 'product' ? shot.feature_id ?? null : null,
      count: Math.min(20, Math.max(1, Math.round(shot.count ?? 3))),
      sort_order: start + index
    }
  })
  if (rows.length) check(await db.from('still_shots').insert(rows))
}

/** Change a still: its description, feature or how many photos it wants. */
export async function updateStillShot(db: Db, bundle: LoadedShoot, id: string, input: StillShotInput) {
  const still = staticsOf(bundle).stills.find(entry => entry.id === id)
  if (!still) throw new Error('That still isn\'t on this shoot.')
  const fields: Partial<Row<'still_shots'>> = {}
  if (input.description !== undefined) {
    if (!input.description.trim()) throw new Error('Describe the still.')
    fields.description = input.description.trim()
  }
  if (input.feature_id !== undefined) fields.feature_id = still.kind === 'product' ? input.feature_id : null
  if (input.count !== undefined) fields.count = Math.min(20, Math.max(1, Math.round(input.count)))
  if (Object.keys(fields).length) check(await db.from('still_shots').update(fields).eq('id', id))
}

export async function removeStillShots(db: Db, bundle: LoadedShoot, ids: string[]) {
  requireDraft(bundle, 'its stills')
  if (ids.length) check(await db.from('still_shots').delete().in('id', ids))
}

// --- handing statics to Kanvas ----------------------------------------------------------------

/** How long the links in a manifest's static plan last: long enough for Kanvas to prep and render. */
export const STATIC_LINK_SECONDS = 60 * 60 * 24 * 30

/**
 * A manifest with signed links on its static plan's files (example ads, logos, font files), so
 * Kanvas can fetch them from Kreate's private storage. The plan hash doesn't include them.
 */
export async function withStaticLinks<T extends { plan: { static?: PlanStatic | null } }>(db: Db, manifest: T): Promise<T> {
  const plan = manifest.plan.static
  if (!plan) return manifest
  const references = await signedStaticReferences(db, plan.formats.flatMap(format => format.references.map(ref => ref.path)), STATIC_LINK_SECONDS)
  const kitPaths = plan.brand_kit ? [...plan.brand_kit.logos.map(logo => logo.path), ...plan.brand_kit.fonts.flatMap(font => font.file ? [font.file] : [])] : []
  const kit = await signedBrandKitFiles(db, kitPaths, STATIC_LINK_SECONDS)
  return {
    ...manifest,
    plan: {
      ...manifest.plan,
      static: {
        ...plan,
        formats: plan.formats.map(format => ({ ...format, references: format.references.map(ref => ({ ...ref, url: references[ref.path] })) })),
        brand_kit: plan.brand_kit
          ? {
              ...plan.brand_kit,
              logos: plan.brand_kit.logos.map(logo => ({ ...logo, url: kit[logo.path] })),
              fonts: plan.brand_kit.fonts.map(font => ({ ...font, url: font.file ? kit[font.file] : undefined }))
            }
          : null
      }
    }
  }
}
