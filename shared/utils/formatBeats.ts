import { parseBeatSuggestions, parseSuggestions } from './broll'
import type { BeatShow } from './shootsheet'
import { DEFAULT_BEATS } from './shootsheet'

/** A beat as the AI connector gives it for a format: its name and, optionally, everything about it. */
export interface FormatBeatInput {
  beat: string
  guidance?: string
  example?: string
  show?: BeatShow
  broll?: string[]
}

/** The beat columns of a format as stored. */
export interface FormatBeatRow {
  kind: string
  beats: string[]
  beat_descriptions: unknown
  beat_examples: unknown
  beat_display: unknown
  beat_broll: unknown
}

const HOOK = 'hook'
const CTA = 'cta'
const asMap = <T>(value: unknown): Record<string, T> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {}

/**
 * The beat columns a format saves, as the format editor writes them: beats lowercase and unique;
 * a standalone format opens with "hook" and closes with "cta" (never over b-roll) and has a beat
 * between; guidance, examples and b-roll only for beats it has; how every beat is shown written out
 * in full. `beats` replaces the beats (each keeping what `current` had for it unless given anew);
 * left out, the current beats stay (switching class adds or drops the hook and cta).
 */
export function formatBeatColumns(kind: 'modular' | 'standalone', beats: FormatBeatInput[] | undefined, current: FormatBeatRow | null) {
  const standalone = kind === 'standalone'
  let names = beats ? beats.map(entry => entry.beat.trim().toLowerCase()).filter(Boolean) : [...(current?.beats ?? DEFAULT_BEATS)]
  names = [...new Set(names)]
  if (standalone) names = [HOOK, ...names.filter(name => name !== HOOK && name !== CTA), CTA]
  else if (!beats && current?.kind === 'standalone') names = names.filter(name => name !== HOOK && name !== CTA)
  if (!names.length) names = [...DEFAULT_BEATS]
  if (standalone && names.length < 3) throw new Error('A standalone format needs at least one beat between its hook and cta.')

  const given = new Map((beats ?? []).map(entry => [entry.beat.trim().toLowerCase(), entry]))
  const was = {
    descriptions: asMap<string>(current?.beat_descriptions),
    examples: asMap<string>(current?.beat_examples),
    display: asMap<BeatShow>(current?.beat_display),
    broll: parseBeatSuggestions(current?.beat_broll)
  }
  const ends = (name: string) => standalone && (name === HOOK || name === CTA)
  const show = (name: string): BeatShow => {
    const asked = given.get(name)?.show
    if (ends(name)) {
      if (asked === 'broll') throw new Error(`A standalone format's ${name} is never over b-roll: use face, screen or voice_note.`)
      const set = asked ?? was.display[name]
      return set && set !== 'broll' ? set : 'face'
    }
    return asked ?? was.display[name] ?? 'broll'
  }
  const pick = (name: string, key: 'guidance' | 'example', old: Record<string, string>) => (given.get(name)?.[key] ?? old[name] ?? '').trim()
  return {
    kind,
    beats: names,
    beat_descriptions: Object.fromEntries(names.map(name => [name, pick(name, 'guidance', was.descriptions)]).filter(([, value]) => value)),
    beat_examples: Object.fromEntries(names.map(name => [name, pick(name, 'example', was.examples)]).filter(([, value]) => value)),
    beat_display: Object.fromEntries(names.map(name => [name, show(name)])) as Record<string, BeatShow>,
    beat_broll: Object.fromEntries(names
      .map((name) => {
        const asked = given.get(name)?.broll
        return [name, asked ? parseSuggestions(asked.map(description => ({ description }))) : was.broll[name] ?? []] as const
      })
      .filter(([, shots]) => shots.length))
  }
}
