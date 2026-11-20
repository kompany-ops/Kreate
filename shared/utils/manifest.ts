// The shoot's manifest (spec §14): one index of every clip in edited/, built when the shoot goes
// Live, so batching and later tools read it instead of Dropbox. Pure: the app lists Dropbox and
// reads Klip's index (edited/_klip.json), and passes them in.
//
// Klip edits each take in raw/ into building blocks in edited/: the clip, its captions, and
// whatever the shoot's treatments need (a cut-out, retro captions), plus text for some treatments.
// Its index says what it made; Kreate never inspects edited/ media (docs/contract.md).
//
// Paths here are relative to the shoot's raw/ or edited/ folder, e.g.
// "topdognix/hooks/joe/H01.mov" or "topdognix/b-roll/problem/IMG_4821.mov".

import type { BundleItem, ShootBundle } from './shootsheet'
import type { BeatShow } from './shootsheet'
import { MANIFEST_SCHEMA_VERSION, beatShow, brollFolder, buildShootsheet, channelFolder, isStandalone, itemBeats, linkedCodes, resolveItemScript, shootFolder, takeLabel, takeSpot } from './shootsheet'
import type { Ingredient, KlipIndex, KlipTake, TakeBlocks, TakeRole, TakeText } from './klip'
import { BLOCKS, ingredientsFor, isDrawable, isTextIngredient, planHash, takeRole, treatmentIngredients } from './klip'
import { DEFAULT_WORDS_PER_SECOND, beatWordings, estimateSeconds, parseBeats, parseTakeKey } from './slots'

const MEDIA = new Set(['mov', 'mp4', 'm4v', 'hevc', 'webm', 'm4a', 'mp3', 'wav', 'aac', 'caf', 'aif', 'aiff'])

const extension = (path: string) => path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
const withoutExtension = (path: string) => path.lastIndexOf('.') > path.lastIndexOf('/') ? path.slice(0, path.lastIndexOf('.')) : path
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** a media file (not captions, notes or Klip's index), and not hidden */
export const isMedia = (path: string) => MEDIA.has(extension(path)) && !fileName(path).startsWith('.')
/** one of Klip's blocks beside a clip (<spot>.<block>.<ext>): never a clip of its own */
const isBlockFile = (path: string) => BLOCKS.some(block => withoutExtension(fileName(path)).toLowerCase().endsWith(`.${block}`))
/** a clip in a listing: media, and not a block */
export const isClip = (path: string) => isMedia(path) && !isBlockFile(path)

/** A take's file relative to raw/ or edited/, without extension: "topdognix/vo/joe/problem/V01". */
export const spotPath = (bundle: ShootBundle, item: BundleItem, beat: string | null): string => takeSpot(bundle, item, beat)

/** Every take the shoot's filmed items need: one per item per beat (hooks and CTAs one). */
export function expectedSpots(bundle: ShootBundle) {
  return bundle.items
    .filter(item => item.status === 'filmed')
    .flatMap(item => itemBeats(item).map(beat => ({ item, beat, spot: spotPath(bundle, item, beat), role: takeRole(item, beat) })))
}

/** The treatments Klip makes things for: those that are on, can be drawn, and need something. */
export const shootIngredients = (bundle: ShootBundle) => (bundle.treatments ?? [])
  .filter(isDrawable)
  .map(treatment => ({ name: treatment.name, needs: treatmentIngredients(treatment) }))
  .filter(treatment => treatment.needs.length)

/** Does Klip's take have an ingredient (a block made, or text written)? */
function indexHas(take: KlipTake, ingredient: Ingredient) {
  if (isTextIngredient(ingredient)) return !!take.text?.[ingredient]
  return !!take.files[ingredient]
}

// --- checking Klip's work ----------------------------------------------------------

export interface EditsCheck {
  ok: boolean
  problems: string[]
  /** things a person should look at; they never block going Live */
  warnings: string[]
  rawClips: number
  editedClips: number
}

/**
 * Before a shoot goes Live (docs/contract.md §7): Klip's index is there, for this plan; every
 * filmed take was edited, with its clip and captions in edited/; every treatment that's on has its
 * ingredients for the takes it covers; every raw media file is accounted for; and nothing is still
 * waiting on a phone. `index` is edited/_klip.json, parsed (null: not there), or an error reading it.
 */
export function checkEdits(
  bundle: ShootBundle,
  raw: string[],
  edited: string[],
  index: KlipIndex | null | { error: string },
  options: { onPhones?: number, planHash?: string } = {}
): EditsCheck {
  const problems: string[] = []
  const warnings: string[] = []
  const person = (id: string) => bundle.people.find(p => p.id === id)?.name ?? 'someone'
  const channel = (id: string | null) => bundle.channels.find(c => c.id === id)?.name ?? 'no channel'
  const list = (files: string[]) => files.slice(0, 6).join(', ') + (files.length > 6 ? `… (${files.length - 6} more)` : '')
  const rawMedia = raw.filter(isMedia)
  const done = (editedClips = 0) => ({ ok: !problems.length, problems, warnings, rawClips: rawMedia.length, editedClips })
  if (options.onPhones) problems.push(`${options.onPhones} clip${options.onPhones === 1 ? ' is' : 's are'} still on phones: upload them first`)

  if (!index) {
    problems.push('Klip hasn\'t finished: there\'s no edited/_klip.json yet')
    return done()
  }
  if ('error' in index) {
    problems.push(index.error)
    return done()
  }
  const expectedHash = options.planHash ?? planHash(bundle)
  if (index.plan_hash !== expectedHash) problems.push('Klip worked from a different plan (the takes or treatments changed since): run Klip again')

  const listed = new Set(edited.map(file => file.toLowerCase()))
  const bySpot = new Map(index.takes.map(take => [take.spot.toLowerCase(), take]))
  const treatments = shootIngredients(bundle)
  const missing = new Map(treatments.map(treatment => [treatment.name, [] as string[]]))

  for (const { item, beat, spot, role } of expectedSpots(bundle)) {
    const label = `${item.code}${beat ? ` ${takeLabel(beat)}` : ''} (${person(item.person_id)}, ${channel(item.channel_id)})`
    const take = bySpot.get(spot.toLowerCase())
    if (!take) {
      problems.push(`${label}: not edited yet (no take at ${spot})`)
      continue
    }
    if (take.status === 'failed') {
      problems.push(`${label}: Klip couldn't edit it${take.review.reasons.length ? ` (${take.review.reasons.join('; ')})` : ''}`)
      continue
    }
    for (const block of ['clip', 'captions'] as const) {
      const file = take.files[block]
      if (!file) problems.push(`${label}: no ${block === 'clip' ? 'edited clip' : 'captions'} yet`)
      else if (!listed.has(file.toLowerCase())) problems.push(`${label}: edited/${file} isn't in Dropbox`)
    }
    if (take.review.needed) warnings.push(`${label}: ${[...take.review.reasons, ...take.review.notes].join('; ') || 'worth a look'}`)
    // each treatment's ingredients, on the takes it covers
    for (const treatment of treatments) {
      for (const need of treatment.needs.filter(need => need.roles.includes(role))) {
        if (!indexHas(take, need.ingredient)) missing.get(treatment.name)!.push(`${spot} (${need.ingredient})`)
        else if (!isTextIngredient(need.ingredient) && !listed.has(take.files[need.ingredient]!.toLowerCase())) {
          missing.get(treatment.name)!.push(`${spot} (${need.ingredient} not in Dropbox)`)
        }
      }
    }
  }
  for (const [name, spots] of missing) {
    if (spots.length) problems.push(`${name}: missing for ${spots.length} take${spots.length === 1 ? '' : 's'} (${list(spots)})`)
  }

  // every raw media file is accounted for: a take, b-roll, or something Klip set aside
  const known = new Set([...index.takes.map(take => take.raw_file), ...index.broll.map(clip => clip.raw_file)].map(file => file.toLowerCase()))
  const setAside = new Map(index.unknown.map(entry => [entry.raw_file.toLowerCase(), entry.reason]))
  const waiting = rawMedia.filter(file => !known.has(file.toLowerCase()) && !setAside.has(file.toLowerCase()))
  if (waiting.length) problems.push(`Not edited yet: ${list(waiting)}`)
  const duplicates = index.unknown.filter(entry => entry.reason === 'duplicate').map(entry => entry.raw_file)
  const noSpot = index.unknown.filter(entry => entry.reason === 'no spot').map(entry => entry.raw_file)
  if (duplicates.length) problems.push(`More than one file at the same place in raw/, so Klip edited none of them: ${list(duplicates)}`)
  if (noSpot.length) problems.push(`In raw/ but not where any take or b-roll goes (renamed or misplaced?): ${list(noSpot)}`)
  const failedBroll = index.broll.filter(clip => clip.status === 'failed').map(clip => clip.raw_file)
  if (failedBroll.length) problems.push(`Klip couldn't edit this b-roll: ${list(failedBroll)}`)

  return done(index.takes.filter(take => take.status === 'edited').length + index.broll.filter(clip => clip.status === 'edited').length)
}

// --- the manifest -----------------------------------------------------------------------

interface ClipBase {
  channel: string
  /**
   * relative to edited/ (what the stitcher reads) and raw/ (where it was uploaded); each keeps
   * its own extension, and raw_file is null when there's no clip at that place in raw/
   */
  file: string
  raw_file: string | null
  /** seconds, from Klip's index */
  duration: number | null
}

export interface TakeClip extends ClipBase {
  kind: 'hook' | 'vo' | 'cta'
  /** the shoot item (one per channel; a take that fills several channels appears once per channel) */
  item_id: string
  person: string
  code: string
  /** VOs: the beat this file is */
  beat: string | null
  /** which wording: of a VO's beat (1 = the first; alternates 2, 3…), or of a hook or CTA (null = the first) */
  option?: number | null
  /**
   * VOs: how the beat is shown: the speaker on camera (face), their voice over b-roll (broll), a
   * voice-note bubble (voice_note), or text on screen (screen: not filmed, so no file; `script` is
   * the message and `duration` its reading time)
   */
  show?: BeatShow | null
  /** VOs: a standalone format's VO, which opens and closes itself (its hook and cta beats) */
  standalone?: boolean
  /** VOs: the format */
  format: string | null
  /** VOs: the slug of the product feature it's about; feature b-roll only goes under VOs about its feature */
  feature: string | null
  /** VOs: the hook / CTA codes it's linked to, the only ones it goes with; null = any */
  hooks?: string[] | null
  ctas?: string[] | null
  /** CTAs: sync (on camera) or vo (over b-roll) */
  mode: string | null
  /** hooks, and a standalone VO's hook-beat wordings: the hook type */
  hook_type: string | null
  script: string
  /** the take's role (docs/contract.md §3): hook, cta, or a VO beat */
  role: TakeRole
  /** its blocks beside `file` in edited/: captions, and what the shoot's treatments need (null: not filmed) */
  blocks: TakeBlocks | null
  /** text Klip wrote for treatments (a search query, placed text), when they need it */
  text?: TakeText
}

export interface BrollClip extends ClipBase {
  kind: 'broll'
  /** the beat folder it's filed in ("problem", "product"…), or "general" for product shots */
  section: string
  /** the feature folder inside it (b-roll/<beat>/<feature>/), a feature slug; null = generic, for any VO */
  feature: string | null
  /** the b-roll shot it was filmed for, when it was added in the checklist */
  shot: { id: string, description: string, beat: string, general: boolean } | null
}

export type ManifestClip = TakeClip | BrollClip

export interface Manifest {
  schema_version: number
  version: number
  /** what Klip works from, hashed (docs/contract.md §7): Klip copies it into its index */
  plan_hash?: string
  generated_at: string
  /** the plan: shoot, people, channels, formats, items and b-roll shots (shootsheet) */
  plan: ReturnType<typeof buildShootsheet>
  clips: ManifestClip[]
  /**
   * What the edit check found, when someone marked it ready anyway. Missing takes aren't in
   * `clips` and clips without a length can't go in recipes, so recipes needing them aren't made.
   */
  overridden?: string[]
}

/**
 * The manifest for a shoot whose edits check out, from Klip's index (edited/_klip.json).
 * `brollShots` maps a b-roll clip's raw path to the shot it was added for (from the checklist's
 * clip records).
 */
export function buildManifest(
  bundle: ShootBundle,
  index: KlipIndex,
  options: { version: number, generatedAt: string, brollShots?: Map<string, string>, overridden?: string[], wordsPerSecond?: number }
): Manifest {
  const clips: ManifestClip[] = []
  const personSlug = (id: string) => bundle.people.find(p => p.id === id)?.slug ?? 'unknown'
  const bySpot = new Map(index.takes.filter(take => take.status === 'edited' && take.files.clip).map(take => [take.spot.toLowerCase(), take]))
  const treatments = (bundle.treatments ?? []).filter(isDrawable)

  for (const { item, beat, spot, role } of expectedSpots(bundle)) {
    const indexed = bySpot.get(spot.toLowerCase())
    if (!indexed) continue
    const script = resolveItemScript(bundle, item)
    // a VO take: one wording of one beat; a hook or CTA's other wording: just its option
    const parsed = beat ? parseTakeKey(beat) : null
    const take = parsed?.beat ? parsed : null
    const option = parsed?.option ?? 1
    const wording = take ? beatWordings(script.beats?.find(b => b.beat === take.beat) ?? { beat: take.beat, script: '' }).find(w => w.option === take.option) : null
    // the blocks the shoot needs of this take: captions always, plus its treatments' blocks
    const blocks: TakeBlocks = { captions: indexed.files.captions }
    const text: TakeText = {}
    for (const ingredient of ingredientsFor(treatments, role)) {
      if (isTextIngredient(ingredient)) {
        const written = indexed.text?.[ingredient]
        if (written) Object.assign(text, { [ingredient]: written })
      } else {
        blocks[ingredient] = indexed.files[ingredient] ?? null
      }
    }
    clips.push({
      kind: item.kind === 'body' ? 'vo' : item.kind,
      role,
      channel: channelFolder(bundle, item.channel_id),
      item_id: item.id,
      person: personSlug(item.person_id),
      code: item.code,
      beat: take?.beat ?? null,
      option: take ? take.option : option > 1 ? option : null,
      show: take ? beatShow(item.format, take.beat) : null,
      ...(item.kind === 'body' ? { standalone: isStandalone(item) } : {}),
      format: item.format?.code ?? null,
      feature: item.kind === 'body' ? item.feature_slug ?? null : null,
      hooks: item.kind === 'body' ? linkedCodes(bundle, item, 'hook') : null,
      ctas: item.kind === 'body' ? linkedCodes(bundle, item, 'cta') : null,
      mode: item.cta_mode,
      hook_type: item.kind === 'hook' ? item.hook_type : wording?.hook_type ?? null,
      script: take ? wording?.script ?? '' : option > 1 ? script.alternates[option - 2] ?? '' : script.text ?? '',
      file: indexed.files.clip!,
      raw_file: indexed.raw_file,
      blocks,
      ...(Object.keys(text).length ? { text } : {}),
      duration: indexed.duration ?? null
    })
  }

  // beats shown on screen: text, not filmed. Each wording is a clip with no file, its length the
  // time to read it (plus a moment for the typing dots), for every filmed VO that has them.
  const pace = options.wordsPerSecond || DEFAULT_WORDS_PER_SECOND
  const filmedVos = new Set(clips.filter(clip => clip.kind === 'vo').map(clip => (clip as TakeClip).item_id))
  for (const item of bundle.items.filter(item => item.kind === 'body' && filmedVos.has(item.id))) {
    const script = resolveItemScript(bundle, item)
    for (const beat of parseBeats(item.script_snapshot)) {
      if (beatShow(item.format, beat.beat) !== 'screen') continue
      const resolved = script.beats?.find(b => b.beat === beat.beat) ?? beat
      for (const wording of beatWordings(resolved)) {
        clips.push({
          kind: 'vo',
          role: takeRole(item, beat.beat),
          channel: channelFolder(bundle, item.channel_id),
          item_id: item.id,
          person: personSlug(item.person_id),
          code: item.code,
          beat: beat.beat,
          option: wording.option,
          show: 'screen',
          standalone: isStandalone(item),
          format: item.format?.code ?? null,
          feature: item.feature_slug ?? null,
          hooks: linkedCodes(bundle, item, 'hook'),
          ctas: linkedCodes(bundle, item, 'cta'),
          mode: null,
          hook_type: wording.hook_type,
          script: wording.script,
          file: '',
          raw_file: null,
          blocks: null,
          duration: estimateSeconds(wording.script, pace) + 1
        })
      }
    }
  }

  // b-roll: every clip Klip edited in each channel's b-roll folders (the folders are kept, only the
  // extension changes), matched to its shot by its raw path. A clip in a feature folder
  // (b-roll/<beat>/<feature>/) is for that feature; one directly in the beat folder is generic.
  const shots = new Map(bundle.broll.filter(shot => shot.id).map(shot => [shot.id!, shot]))
  const shotByName = new Map([...(options.brollShots ?? [])].map(([path, id]) => [withoutExtension(path).toLowerCase(), id]))
  for (const clip of index.broll) {
    if (clip.status !== 'edited' || !clip.file) continue
    const match = clip.file.match(/^([^/]+)\/b-roll\/([^/]+)\/(?:([^/]+)\/)?[^/]+$/)
    if (!match) continue
    const [, channel, section, feature] = match as unknown as [string, string, string, string | undefined]
    const shotId = shotByName.get(withoutExtension(clip.raw_file).toLowerCase())
    const shot = shotId ? shots.get(shotId) ?? null : null
    clips.push({
      kind: 'broll',
      channel,
      section,
      feature: feature ?? null,
      file: clip.file,
      raw_file: clip.raw_file,
      duration: clip.duration ?? null,
      shot: shot ? { id: shot.id!, description: shot.description, beat: shot.beat, general: !shot.format_id } : null
    })
  }

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    version: options.version,
    plan_hash: planHash(bundle),
    generated_at: options.generatedAt,
    plan: buildShootsheet(bundle),
    clips,
    ...(options.overridden?.length ? { overridden: options.overridden } : {})
  }
}

/** A b-roll clip's raw path (relative to raw/), from where the checklist uploaded it. */
export function relativeToStage(bundle: ShootBundle, fullPath: string, root: string, stage: 'raw' | 'edited') {
  const prefix = `${root}/${shootFolder(bundle)}/${stage}/`.toLowerCase()
  return fullPath.toLowerCase().startsWith(prefix) ? fullPath.slice(prefix.length) : null
}

/** Where a b-roll clip for a shot goes, relative to raw/: its channel's beat (or general) folder. */
export const brollFolderRelative = (bundle: ShootBundle, shot: Parameters<typeof brollFolder>[1], channelId: string | null) =>
  brollFolder(bundle, shot, channelId, 'raw').slice(`${shootFolder(bundle)}/raw/`.length)
