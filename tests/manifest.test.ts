import { describe, expect, it } from 'vitest'
import type { BundleItem, BundleTreatment, ShootBundle } from '../shared/utils/shootsheet'
import type { KlipIndex, KlipTake } from '../shared/utils/klip'
import { buildManifest, checkEdits, isClip } from '../shared/utils/manifest'
import { ingredientsFor, isDrawable, planHash, treatmentIngredients } from '../shared/utils/klip'
import { buildShootsheet, planManifest } from '../shared/utils/shootsheet'

const format = { code: 'F01', cta_modes: ['sync', 'vo'], beats: ['problem', 'product'] }

function item(id: string, code: string, kind: BundleItem['kind'], channel: string, extra: Partial<BundleItem> = {}): BundleItem {
  return {
    id, code, kind, person_id: 'p1', channel_id: channel,
    script_snapshot: kind === 'body' ? [{ beat: 'problem', script: 'My dog pulled' }, { beat: 'product', script: 'Then {{product}}' }] : 'Watch {{dog}} go',
    script_override: null, cta_mode: kind === 'cta' ? 'sync' : null, location: null, status: 'filmed', sort_order: 0,
    template_id: `t-${id}`, hook_type: null, format: kind === 'body' ? format : null, ...extra
  }
}

/** Joe on Nix: a hook, a VO (two beats) and a CTA, plus a b-roll shot. */
function bundle(treatments: BundleTreatment[] = []): ShootBundle {
  return {
    shoot: { code: 'S001', shoot_date: '2026-10-20', status: 'filmed', broll_variations: 1, submission_rate: 0.05 },
    brand: { name: 'PawCo', slug: 'pawco' },
    product: { name: 'Calming Chews', slug: 'calming-chews' },
    people: [{ id: 'p1', slug: 'joe', name: 'Joe' }],
    channels: [{ id: 'c1', name: 'topdognix', slug: 'topdognix', folder_slug: 'nix', dogs: ['nix'], slot_values: { dog: 'my Doberman' } }],
    items: [item('h', 'H01', 'hook', 'c1'), item('v', 'V01', 'body', 'c1'), item('c', 'C01', 'cta', 'c1'), item('s', 'H02', 'hook', 'c1', { status: 'skipped' })],
    broll: [{ id: 'b1', channel_id: null, format_id: 'f1', beat: 'problem', description: 'pacing', status: 'filmed' }],
    channelPeople: { c1: ['p1'] },
    treatments
  }
}

const takes: [string, KlipTake['role']][] = [
  ['topdognix/hooks/joe/H01', 'hook'], ['topdognix/vo/joe/problem/V01', 'beat'], ['topdognix/vo/joe/product/V01', 'beat'], ['topdognix/ctas/joe/C01', 'cta']
]
const brollRaw = ['topdognix/b-roll/problem/IMG_1.MOV', 'topdognix/b-roll/general/IMG_9.MOV', 'topdognix/b-roll/problem/calming/IMG_5.MOV']
const raw = [...takes.map(([spot]) => `${spot}.mov`), ...brollRaw]

/** Klip's index for the bundle: every take edited with its clip and captions, every b-roll clip graded. */
function index(b: ShootBundle, edit: (take: KlipTake) => KlipTake = take => take): KlipIndex {
  return {
    schema_version: 2,
    klip_version: '0.1.0',
    plan_hash: planHash(b),
    shoot: 'S001',
    updated_at: '2026-10-21T10:00:00Z',
    complete: true,
    takes: takes.map(([spot, role]) => edit({
      spot, raw_file: `${spot}.mov`, role, status: 'edited',
      files: { clip: `${spot}.mp4`, captions: `${spot}.captions.webm` },
      duration: 2.5, frames: 150, fps: 60,
      review: { needed: false, reasons: [], notes: [] }
    })),
    broll: brollRaw.map(file => ({ file: file.replace('.MOV', '.mp4'), raw_file: file, status: 'edited' as const, duration: 2.5, frames: 150, fps: 60 })),
    unknown: []
  }
}
/** what's in edited/: every file the index names */
const editedOf = (klip: KlipIndex) => [
  ...klip.takes.flatMap(take => Object.values(take.files).filter((file): file is string => !!file)),
  ...klip.broll.flatMap(clip => clip.file ? [clip.file] : []),
  '_klip.json', '_review.md'
]

describe('checkEdits', () => {
  it('passes when Klip edited every take for this plan, with its clip and captions in edited/', () => {
    const klip = index(bundle())
    expect(checkEdits(bundle(), raw, editedOf(klip), klip)).toMatchObject({ ok: true, problems: [], warnings: [], rawClips: 7, editedClips: 7 })
  })

  it('wants Klip’s index, for this plan', () => {
    expect(checkEdits(bundle(), raw, [], null).problems).toEqual(['Klip hasn\'t finished: there\'s no edited/_klip.json yet'])
    expect(checkEdits(bundle(), raw, [], { error: 'not valid' }).problems).toEqual(['not valid'])
    const old = { ...index(bundle()), plan_hash: 'sha256:old' }
    expect(checkEdits(bundle(), raw, editedOf(old), old).problems).toEqual(['Klip worked from a different plan (the takes or treatments changed since): run Klip again'])
    // the plan Klip was given can be passed in (the manifest it read)
    expect(checkEdits(bundle(), raw, editedOf(old), old, { planHash: 'sha256:old' }).ok).toBe(true)
  })

  it('flags takes Klip couldn’t edit, blocks that aren’t there, and clips still on phones', () => {
    const klip = index(bundle(), take => take.spot.endsWith('C01')
      ? { ...take, status: 'failed', files: { clip: null, captions: null }, review: { needed: true, reasons: ['no speech found'], notes: [] } }
      : take.spot.endsWith('H01') ? { ...take, files: { ...take.files, captions: null } } : take)
    const edited = editedOf(klip).filter(file => !file.includes('problem/V01.mp4'))
    expect(checkEdits(bundle(), raw, edited, klip, { onPhones: 1 }).problems).toEqual([
      '1 clip is still on phones: upload them first',
      'H01 (Joe, topdognix): no captions yet',
      'V01 problem (Joe, topdognix): edited/topdognix/vo/joe/problem/V01.mp4 isn\'t in Dropbox',
      'C01 (Joe, topdognix): Klip couldn\'t edit it (no speech found)'
    ])
  })

  it('accounts for every raw clip: edited, still waiting, or set aside', () => {
    const klip = { ...index(bundle()), unknown: [
      { raw_file: 'topdognix/ctas/joe/C02.mov', reason: 'duplicate' as const },
      { raw_file: 'topdognix/ctas/joe/C02 (1).mov', reason: 'duplicate' as const },
      { raw_file: 'topdognix/hooks/joe/H1.mov', reason: 'no spot' as const }
    ] }
    const problems = checkEdits(bundle(), [...raw, 'topdognix/b-roll/general/IMG_10.MOV', 'topdognix/ctas/joe/C02.mov', 'topdognix/ctas/joe/C02 (1).mov', 'topdognix/hooks/joe/H1.mov', 'topdognix/hooks/joe/H01.srt'], editedOf(klip), klip).problems
    expect(problems).toEqual([
      'Not edited yet: topdognix/b-roll/general/IMG_10.MOV',
      'More than one file at the same place in raw/, so Klip edited none of them: topdognix/ctas/joe/C02.mov, topdognix/ctas/joe/C02 (1).mov',
      'In raw/ but not where any take or b-roll goes (renamed or misplaced?): topdognix/hooks/joe/H1.mov'
    ])
  })

  it('shows what Klip wants a person to look at, without stopping the shoot going Live', () => {
    const klip = index(bundle(), take => take.spot.endsWith('H01') ? { ...take, review: { needed: true, reasons: ['Claude\'s confidence is 0.52'], notes: [] } } : take)
    expect(checkEdits(bundle(), raw, editedOf(klip), klip)).toMatchObject({ ok: true, warnings: ['H01 (Joe, topdognix): Claude\'s confidence is 0.52'] })
  })
})

describe('buildManifest', () => {
  it('indexes every take with its role, script, files, blocks and length, and the b-roll with its shot', () => {
    const b = bundle()
    const manifest = buildManifest(b, index(b), {
      version: 1,
      generatedAt: '2026-10-21T10:00:00Z',
      brollShots: new Map([['topdognix/b-roll/problem/img_1.mov', 'b1']])
    })
    expect(manifest).toMatchObject({ version: 1, schema_version: 11, plan_hash: planHash(b) })
    // the edited clip and the raw one it came from, each under its own extension
    expect(manifest.clips[0]).toMatchObject({ file: 'topdognix/hooks/joe/H01.mp4', raw_file: 'topdognix/hooks/joe/H01.mov', blocks: { captions: 'topdognix/hooks/joe/H01.captions.webm' } })
    expect(manifest.clips[4]).toMatchObject({ file: 'topdognix/b-roll/problem/IMG_1.mp4', raw_file: 'topdognix/b-roll/problem/IMG_1.MOV' })
    expect(manifest.clips.map(clip => clip.kind === 'broll' ? `broll ${clip.file}` : `${clip.code} ${clip.beat ?? ''}`.trim())).toEqual([
      'H01', 'V01 problem', 'V01 product', 'C01',
      'broll topdognix/b-roll/problem/IMG_1.mp4', 'broll topdognix/b-roll/general/IMG_9.mp4',
      'broll topdognix/b-roll/problem/calming/IMG_5.mp4'
    ])
    // a clip in a feature folder is for that feature; the rest are generic
    expect(manifest.clips[6]).toMatchObject({ section: 'problem', feature: 'calming' })
    expect(manifest.clips[4]).toMatchObject({ feature: null })
    expect(manifest.clips[0]).toMatchObject({ kind: 'hook', role: 'hook', channel: 'topdognix', person: 'joe', script: 'Watch my Doberman go', duration: 2.5 })
    expect(manifest.clips[1]).toMatchObject({ kind: 'vo', role: 'beat', beat: 'problem', script: 'My dog pulled' })
    expect(manifest.clips[1]).not.toHaveProperty('caption')
    // the clip added for shot b1 knows its shot; one added some other way doesn't
    expect(manifest.clips[4]).toMatchObject({ section: 'problem', shot: { id: 'b1' } })
    expect(manifest.clips[5]).toMatchObject({ section: 'general', shot: null })
  })

  it('records the problems it was marked ready with, and leaves out what Klip couldn’t edit', () => {
    const b = bundle()
    const klip = index(b, take => take.spot.endsWith('C01') ? { ...take, status: 'failed', files: { clip: null, captions: null } } : take)
    const manifest = buildManifest(b, klip, { version: 2, generatedAt: '', overridden: ['C01 (Joe, topdognix): Klip couldn\'t edit it'] })
    expect(manifest.overridden).toHaveLength(1)
    expect(manifest.clips.some(clip => clip.kind === 'cta')).toBe(false)
  })
})

describe('a text thread', () => {
  const thread = { code: 'F21', cta_modes: [], beats: ['hook', 'voice note', 'cta'], kind: 'standalone', beat_display: { 'hook': 'screen', 'voice note': 'voice_note', 'cta': 'screen' } }
  const b = () => {
    const shoot = bundle()
    shoot.items = [item('t', 'V02', 'body', 'c1', {
      format: thread,
      script_snapshot: [{ beat: 'hook', script: 'ok how is {{product}} so good' }, { beat: 'voice note', script: 'tell me everything' }, { beat: 'cta', script: 'link below' }]
    })]
    return shoot
  }
  const spot = 'topdognix/vo/joe/voice-note/V02'
  const klip = (shoot: ShootBundle): KlipIndex => ({
    ...index(shoot), broll: [],
    takes: [{ spot, raw_file: `${spot}.mov`, role: 'beat', status: 'edited', files: { clip: `${spot}.mp4`, captions: `${spot}.captions.webm` }, duration: 3, frames: 180, fps: 60, review: { needed: false, reasons: [], notes: [] } }]
  })

  it('only wants the voice notes filmed', () => {
    const shoot = b()
    expect(checkEdits(shoot, [`${spot}.mov`], editedOf(klip(shoot)), klip(shoot)).problems).toEqual([])
  })

  it('carries the messages on screen as clips with no file, timed by how long they take to read', () => {
    const shoot = b()
    const manifest = buildManifest(shoot, klip(shoot), { version: 1, generatedAt: '', wordsPerSecond: 2.5 })
    const vo = manifest.clips.filter(clip => clip.kind === 'vo') as { beat: string, show: string, file: string, script: string, duration: number, role: string, blocks: unknown }[]
    expect(vo.map(clip => `${clip.beat}/${clip.show}/${clip.role}`).sort()).toEqual(['cta/screen/cta', 'hook/screen/hook', 'voice note/voice_note/beat'])
    const hook = vo.find(clip => clip.beat === 'hook')!
    expect(hook).toMatchObject({ file: '', script: 'ok how is Calming Chews so good', blocks: null })
    // 6 words at 2.5 a second, plus a moment for the typing dots
    expect(hook.duration).toBe(4)
  })
})

describe('treatment ingredients', () => {
  const treatment = (name: string, component: string, placement: string, kind = 'overlay', parts?: BundleTreatment[]): BundleTreatment =>
    ({ name, kind, placement, needs: [], component, settings: {}, ...(parts ? { parts } : {}) })
  const search = treatment('Search bar', 'search_bar', 'hook')
  const retro = treatment('Retro look', 'retro_look', 'video')
  const greenscreen = treatment('Greenscreen', 'greenscreen', 'video', 'footage')
  const face = treatment('Face to camera', 'layout', 'video', 'layout')
  const thread = treatment('Text thread', 'text_thread', 'video')

  it('follow from the component, over the takes the placement covers', () => {
    expect(treatmentIngredients(search)).toEqual([{ ingredient: 'search_query', roles: ['hook'] }])
    expect(treatmentIngredients(greenscreen)).toEqual([{ ingredient: 'cutout', roles: ['hook', 'cta', 'beat'] }])
    expect(treatmentIngredients(face)).toEqual([])
    // a combination: each part's, over that part's takes
    expect(treatmentIngredients(treatment('Search, then face', 'combo', 'video', 'layout', [search, face]))).toEqual([{ ingredient: 'search_query', roles: ['hook'] }])
    expect(ingredientsFor([search, retro, greenscreen], 'hook').sort()).toEqual(['captions-retro', 'cutout', 'search_query'])
    expect(ingredientsFor([search, retro, greenscreen], 'cta').sort()).toEqual(['captions-retro', 'cutout'])
  })

  it('only come from treatments the renderer can draw', () => {
    expect([search, retro, greenscreen, face].every(isDrawable)).toBe(true)
    expect(isDrawable(thread)).toBe(false)
    expect(isDrawable(treatment('Search, then thread', 'combo', 'video', 'overlay', [search, thread]))).toBe(false)
    const plan = buildShootsheet(bundle([search, thread]))
    expect(plan.treatments.map(t => t.name)).toEqual(['Search bar'])
    expect(plan.treatments[0]).not.toHaveProperty('sidecar')
    expect(plan.treatments[0]).not.toHaveProperty('applies_to')
  })

  it('are checked for on every take a treatment covers', () => {
    const b = bundle([search, greenscreen])
    const klip = index(b)
    expect(checkEdits(b, raw, editedOf(klip), klip).problems).toEqual([
      'Search bar: missing for 1 take (topdognix/hooks/joe/H01 (search_query))',
      'Greenscreen: missing for 4 takes (topdognix/hooks/joe/H01 (cutout), topdognix/vo/joe/problem/V01 (cutout), topdognix/vo/joe/product/V01 (cutout), topdognix/ctas/joe/C01 (cutout))'
    ])
    const made = index(b, take => ({
      ...take,
      files: { ...take.files, cutout: `${take.spot}.cutout.webm` },
      ...(take.role === 'hook' ? { text: { search_query: 'why does my dog pull' } } : {})
    }))
    expect(checkEdits(b, raw, editedOf(made), made)).toMatchObject({ ok: true, problems: [] })
  })

  it('go on each take in the manifest, and blocks are never clips of their own', () => {
    const b = bundle([search, greenscreen])
    const made = index(b, take => ({
      ...take,
      files: { ...take.files, cutout: `${take.spot}.cutout.webm` },
      ...(take.role === 'hook' ? { text: { search_query: 'why does my dog pull' } } : {})
    }))
    const manifest = buildManifest(b, made, { version: 1, generatedAt: '' })
    expect(manifest.clips[0]).toMatchObject({ blocks: { captions: 'topdognix/hooks/joe/H01.captions.webm', cutout: 'topdognix/hooks/joe/H01.cutout.webm' }, text: { search_query: 'why does my dog pull' } })
    expect(manifest.clips[3]).toMatchObject({ kind: 'cta', blocks: { cutout: 'topdognix/ctas/joe/C01.cutout.webm' } })
    expect(manifest.clips[3]).not.toHaveProperty('text')
    expect(isClip('topdognix/hooks/joe/H01.cutout.webm')).toBe(false)
    expect(isClip('topdognix/hooks/joe/H01.captions-retro.webm')).toBe(false)
    expect(isClip('topdognix/hooks/joe/H01.mp4')).toBe(true)
  })
})

describe('the plan hash', () => {
  it('is on the plan manifest Klip reads, and stays put while the shoot is filmed', () => {
    const b = bundle()
    expect(planManifest(b)).toMatchObject({ version: 0, plan_hash: planHash(b) })
    expect(planHash(b)).toMatch(/^sha256:[0-9a-f]{64}$/)
    // b-roll shots added and shots ticked off on set don't change what Klip works from
    const filmed = { ...b, broll: [...b.broll, { id: 'b2', channel_id: null, format_id: null, beat: 'general', description: 'pack shot', status: 'planned' }], items: b.items.map(i => ({ ...i, status: 'planned' })) }
    expect(planHash(filmed)).toBe(planHash(b))
  })

  it('changes when the takes or the treatments do', () => {
    const b = bundle()
    expect(planHash(bundle([{ name: 'Retro look', kind: 'overlay', placement: 'video', needs: [], component: 'retro_look', settings: {} }]))).not.toBe(planHash(b))
    expect(planHash({ ...b, items: [...b.items, item('c2', 'C02', 'cta', 'c1')] })).not.toBe(planHash(b))
  })
})
