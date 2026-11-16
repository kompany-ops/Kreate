import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ShootBundle } from '../shared/utils/shootsheet'
import { KLIP_CONTRACT_VERSION, parseKlipIndex } from '../shared/utils/klip'
import { buildManifest, checkEdits } from '../shared/utils/manifest'
import { sha256Hex } from '../shared/utils/sha256'

// The Kreate ↔ Klip contract (docs/contract.md, docs/contract/_klip.example.json): Kreate's copy,
// the example index, and Klip's copy (when it's checked out beside this repo) all agree, and Kreate
// reads the example the way the contract says (§9).

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const contractVersion = (text: string) => Number(text.match(/^contract_version: (\d+)$/m)?.[1])
const contract = read('docs/contract.md')
const example = JSON.parse(read('docs/contract/_klip.example.json'))

/** The shoot the example index is for: Makayla's standalone VO V01 (hook, problem, cta) on wellbymak. */
function exampleShoot(): ShootBundle {
  const format = { code: 'F11', cta_modes: [], beats: ['hook', 'problem', 'cta'], kind: 'standalone' }
  return {
    shoot: { code: 'S001', shoot_date: '2026-11-15', status: 'filmed', broll_variations: 1, submission_rate: 0.05 },
    brand: { name: 'Wellby', slug: 'wellby' },
    product: { name: 'Energy', slug: 'energy' },
    people: [{ id: 'p1', slug: 'makayla', name: 'Makayla' }],
    channels: [{ id: 'c1', name: 'wellbymak', slug: 'wellbymak', folder_slug: 'wellbymak', slot_values: {} }],
    items: [{
      id: 'v', code: 'V01', kind: 'body', person_id: 'p1', channel_id: 'c1', script_override: null, cta_mode: null, location: null,
      status: 'filmed', sort_order: 0, template_id: 't', hook_type: null, format,
      script_snapshot: [{ beat: 'hook', script: 'Third coffee by 11am?' }, { beat: 'problem', script: 'Still tired' }, { beat: 'cta', script: 'Link below' }]
    }],
    broll: [],
    channelPeople: { c1: ['p1'] },
    treatments: [{ name: 'Search bar', kind: 'overlay', placement: 'hook', needs: ['text'], component: 'search_bar', settings: { position: 'top' } }]
  }
}

describe('the Klip contract', () => {
  it('is the version Kreate implements, in this copy and the example', () => {
    expect(contractVersion(contract)).toBe(KLIP_CONTRACT_VERSION)
    expect(example.schema_version).toBe(KLIP_CONTRACT_VERSION)
  })

  it('matches Klip’s copy, when Klip is checked out beside Kreate', () => {
    const klip = new URL('../../Klip/docs/contract.md', import.meta.url)
    if (!existsSync(klip)) return
    expect(readFileSync(klip, 'utf8')).toBe(contract)
    expect(JSON.parse(readFileSync(new URL('../../Klip/docs/contract/_klip.example.json', import.meta.url), 'utf8'))).toEqual(example)
  })

  it('parses the example index, and refuses a version it doesn’t know', () => {
    expect(parseKlipIndex(example).error).toBeUndefined()
    expect(parseKlipIndex({ ...example, schema_version: 1 }).error).toMatch(/contract version 1; Kreate reads version 2/)
    expect(parseKlipIndex({ ...example, takes: [{ spot: 'x' }] }).error).toMatch(/isn't valid/)
  })

  it('runs Check edits and the manifest builder on the example', () => {
    const { index } = parseKlipIndex(example)
    const edited = [...index!.takes.flatMap(take => Object.values(take.files).filter((file): file is string => !!file)), ...index!.broll.flatMap(clip => clip.file ? [clip.file] : [])]
    const raw = [...index!.takes.map(take => take.raw_file), ...index!.broll.map(clip => clip.raw_file), ...index!.unknown.map(entry => entry.raw_file)]
    const check = checkEdits(exampleShoot(), raw, edited, index!, { planHash: example.plan_hash })
    expect(check.problems).toEqual([
      'V01 cta (Makayla, wellbymak): Klip couldn\'t edit it (edit failed: no speech found)',
      'More than one file at the same place in raw/, so Klip edited none of them: wellbymak/vo/makayla/cta/V02.mov, wellbymak/vo/makayla/cta/V02 (1).mov'
    ])
    // a failed take is already a problem, so only the edited one Klip flagged is a warning
    expect(check.warnings).toEqual(['V01 problem (Makayla, wellbymak): Claude\'s confidence is 0.52'])

    const manifest = buildManifest(exampleShoot(), index!, { version: 1, generatedAt: '' })
    const hook = manifest.clips.find(clip => clip.kind === 'vo' && clip.beat === 'hook')
    expect(hook).toMatchObject({ role: 'hook', file: 'wellbymak/vo/makayla/hook/V01.mp4', duration: 3.833, blocks: { captions: 'wellbymak/vo/makayla/hook/V01.captions.webm' }, text: { search_query: 'why am i always tired even with coffee' } })
    expect(manifest.clips.find(clip => clip.kind === 'broll')).toMatchObject({ section: 'problem', file: 'wellbymak/b-roll/problem/IMG_7687.mp4', duration: 1.75 })
  })
})

describe('sha256Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('hashes UTF-8 and long input the same as Node’s crypto', () => {
    for (const text of ['é🐕 dog parent', 'x'.repeat(1000), JSON.stringify({ takes: ['a|hook'], treatments: [] })]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })
})
