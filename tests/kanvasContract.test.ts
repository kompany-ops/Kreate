import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KANVAS_CONTRACT_VERSION, blockingFlags, parseKanvasIndex, stillAssets } from '../shared/utils/kanvas'

// The Kreate ↔ Kanvas contract (docs/contract-kanvas.md, docs/contract-kanvas/_kanvas.example.json):
// Kreate's copy, the example index, and Kanvas's copy (when it's checked out beside this repo) all
// agree, and Kreate reads the example the way the contract says.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const contractVersion = (text: string) => Number(text.match(/^contract_version: (\d+)$/m)?.[1])
const contract = read('docs/contract-kanvas.md')
const example = JSON.parse(read('docs/contract-kanvas/_kanvas.example.json'))

describe('the Kanvas contract', () => {
  it('is the version Kreate implements, in this copy and the example', () => {
    expect(contractVersion(contract)).toBe(KANVAS_CONTRACT_VERSION)
    expect(example.schema_version).toBe(KANVAS_CONTRACT_VERSION)
  })

  it('matches Kanvas’s copy, when Kanvas is checked out beside Kreate', () => {
    const kanvas = new URL('../../Kanvas/docs/contract.md', import.meta.url)
    if (!existsSync(kanvas)) return
    const lf = (text: string) => text.replace(/\r\n/g, '\n')
    expect(lf(readFileSync(kanvas, 'utf8'))).toBe(lf(contract))
    expect(JSON.parse(readFileSync(new URL('../../Kanvas/docs/contract/_kanvas.example.json', import.meta.url), 'utf8'))).toEqual(example)
  })

  it('parses the example index, and refuses a version or shape it doesn’t know', () => {
    const { index, error } = parseKanvasIndex(example)
    expect(error).toBeUndefined()
    expect(index!.renders).toHaveLength(3)
    expect(parseKanvasIndex({ ...example, schema_version: 2 }).error).toMatch(/contract version 2; Kreate reads version 1/)
    expect(parseKanvasIndex({ ...example, renders: [{ recipe: 'x' }] }).error).toMatch(/isn't valid/)
  })

  it('blocks only on a product Kanvas drew', () => {
    const { index } = parseKanvasIndex(example)
    expect(index!.renders.map(render => blockingFlags(render).map(flag => flag.code))).toEqual([[], ['generated_product'], []])
  })

  it('files stills by channel (product) and person (avatar), relative to the shoot folder', () => {
    expect(stillAssets([
      'topdognix/stills/product/IMG_2.jpg',
      'topdognix/stills/product/IMG_1.HEIC',
      'topdognix/stills/avatar/joe/me.png',
      'topdognix/stills/avatar/joe/notes.txt',
      'topdognix/hooks/joe/H01.mov',
      'topdognix/stills/product/nested/x.jpg'
    ])).toEqual({
      product: { topdognix: ['raw/topdognix/stills/product/IMG_1.HEIC', 'raw/topdognix/stills/product/IMG_2.jpg'] },
      avatar: { joe: ['raw/topdognix/stills/avatar/joe/me.png'] }
    })
  })
})
