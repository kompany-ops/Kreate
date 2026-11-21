import { describe, expect, it } from 'vitest'
import type { PlanStatic } from '../shared/utils/kanvas'
import { buildStaticPlan } from '../shared/utils/kanvas'
import type { StaticRecipeInput } from '../shared/utils/staticRecipes'
import {
  buildStaticRecipes, copyKey, nextStaticBatchCode, pickStaticBatch, staticBatchElements, staticInputFromManifest, staticRecipeElements
} from '../shared/utils/staticRecipes'
import { elementRecords } from '../shared/utils/batchLoop'

const slots = [
  { key: 'headline', label: 'Headline', max_words: 8, guidance: null, example: null, required: true },
  { key: 'sub', label: 'Sub', max_words: null, guidance: null, example: null, required: false }
]
function plan(overrides: Partial<PlanStatic> = {}): PlanStatic {
  return {
    wording_variations: 1,
    formats: [
      { code: 'SF01', name: 'Notes app', description: null, mechanism: null, slots, variants: ['text', 'text_product'], rules: { always: [], never: [] }, references: [], plate: false, text_render: 'ai', sizes: ['4x5', '1x1'] },
      { code: 'SF02', name: 'Mirror note', description: null, mechanism: null, slots: slots.slice(0, 1), variants: ['text_avatar'], rules: { always: [], never: [] }, references: [], plate: false, text_render: 'ai', sizes: ['9x16'] }
    ],
    brand_kit: null,
    copies: [
      {
        code: 'A01', format: 'SF01', channel: null, feature: null, slots: [],
        filled: {
          nix: [{ slot: 'headline', text: 'Nix eats', alternates: ['Dinner, solved'] }, { slot: 'sub', text: 'Two chews', alternates: [] }],
          whiskey: [{ slot: 'headline', text: 'Whiskey eats', alternates: ['Dinner, solved'] }, { slot: 'sub', text: 'Two chews', alternates: [] }]
        }
      },
      { code: 'A02', format: 'SF02', channel: 'nix', feature: null, slots: [], filled: { nix: [{ slot: 'headline', text: 'Me and Nix', alternates: [] }] } }
    ],
    stills: [],
    ...overrides
  }
}
const input = (overrides: Partial<StaticRecipeInput> = {}): StaticRecipeInput => ({
  shoot: 'S001',
  plan: plan(),
  channels: [{ slug: 'nix', people: ['joe', 'mak'] }, { slug: 'whiskey', people: ['joe'] }],
  productPhotos: { nix: ['raw/nix/stills/product/1.jpg', 'raw/nix/stills/product/2.jpg'] },
  avatars: { 'nix|joe': ['raw/nix/stills/avatar/joe/a.jpg'], 'nix|mak': [], 'whiskey|joe': ['edited/whiskey/hooks/joe/H01.mp4'] },
  ...overrides
})

describe('static recipes', () => {
  it('makes one per format, variant, copy wording and channel, where the ingredients are', () => {
    const recipes = buildStaticRecipes(input())
    const summary = recipes.map(recipe => `${recipe.channel}|${recipe.person ?? '-'}|${recipe.format}.${recipe.variant}|${copyKey(recipe.copy)}`)
    expect(summary).toEqual([
      // A01 for every channel: first wordings, then the one mix (headline's second wording)
      'nix|-|SF01.text|A01', 'nix|-|SF01.text_product|A01', 'nix|-|SF01.text|A01.2.1', 'nix|-|SF01.text_product|A01.2.1',
      // A02 is for nix only, a person variant: Joe has an avatar still, Mak has nothing to show
      'nix|joe|SF02.text_avatar|A02',
      'whiskey|-|SF01.text|A01', 'whiskey|-|SF01.text_product|A01', 'whiskey|-|SF01.text|A01.2.1', 'whiskey|-|SF01.text_product|A01.2.1'
    ])
  })

  it('fills the copy, picks photos in turn, and names each recipe the same way every time', () => {
    const recipes = buildStaticRecipes(input())
    const products = recipes.filter(recipe => recipe.channel === 'nix' && recipe.variant === 'text_product')
    expect(products.map(recipe => recipe.assets.product)).toEqual([['raw/nix/stills/product/1.jpg'], ['raw/nix/stills/product/2.jpg']])
    expect(products[1]!.copy.slots).toEqual({ headline: 'Dinner, solved', sub: 'Two chews' })
    // no product stills on whiskey: still made, Kanvas draws the product
    expect(recipes.find(recipe => recipe.channel === 'whiskey' && recipe.variant === 'text_product')!.assets).toEqual({})
    const avatar = recipes.find(recipe => recipe.person === 'joe')!
    expect(avatar.id).toMatch(/^S001_nix_joe_SF02\.text_avatar_A02_[0-9a-f]{8}$/)
    expect(products[1]!.id).toMatch(/^S001_nix_SF01\.text_product_A01\.2\.1_[0-9a-f]{8}$/)
    expect(avatar.sizes).toEqual(['9x16'])
    expect(buildStaticRecipes(input()).map(recipe => recipe.id)).toEqual(recipes.map(recipe => recipe.id))
  })

  it('makes no mixes with wording mixes at 0', () => {
    expect(buildStaticRecipes(input({ plan: plan({ wording_variations: 0 }) })).some(recipe => copyKey(recipe.copy).includes('.'))).toBe(false)
  })

  it('reads a Live manifest: avatar stills first, else a person\'s hooks and CTAs on the channel', () => {
    const built = staticInputFromManifest({
      plan: {
        shoot: { code: 'S001' },
        people: [{ slug: 'joe', channels: ['nix'] }, { slug: 'mak', channels: ['nix'] }],
        channels: [{ slug: 'nix' }],
        static: plan()
      },
      static_assets: { product: {}, avatar: { joe: ['raw/nix/stills/avatar/joe/a.jpg'] } },
      clips: [
        { kind: 'hook', channel: 'nix', person: 'mak', file: 'nix/hooks/mak/H01.mp4' },
        { kind: 'hook', channel: 'nix', person: 'mak', file: 'nix/hooks/mak/H01-2.mp4', option: 2 },
        { kind: 'vo', channel: 'nix', person: 'mak', file: 'nix/vo/mak/problem/V01.mp4' }
      ]
    })!
    expect(built.avatars).toEqual({ 'nix|joe': ['raw/nix/stills/avatar/joe/a.jpg'], 'nix|mak': ['edited/nix/hooks/mak/H01.mp4'] })
    expect(staticInputFromManifest({ plan: { shoot: { code: 'S1' }, people: [], channels: [] }, clips: [] })).toBeNull()
  })
})

describe('static batches', () => {
  it('names elements and codes', () => {
    const recipes = buildStaticRecipes(input())
    expect(staticRecipeElements(recipes.find(recipe => recipe.person)!)).toEqual([
      { kind: 'static_format', key: 'SF02' }, { kind: 'variant', key: 'text_avatar' }, { kind: 'static_copy', key: 'A02' }, { kind: 'avatar', key: 'joe' }
    ])
    expect(staticBatchElements(recipes).map(element => element.kind)).toEqual(['static_format', 'static_format', 'variant', 'variant', 'variant', 'static_copy', 'static_copy', 'static_copy', 'avatar'])
    expect(nextStaticBatchCode(['SB01', 'B07', 'SB03'])).toBe('SB04')
  })

  it('never puts two of one format + copy in a batch, and spreads variants', () => {
    const recipes = buildStaticRecipes(input())
    const pick = pickStaticBatch(recipes, { size: 10 })
    const pairs = pick.recipes.map(recipe => `${recipe.channel}|${recipe.format}|${recipe.copy.code}`)
    // one per format + copy pair across the batch
    expect(new Set(pick.recipes.map(recipe => `${recipe.format}|${recipe.copy.code}`)).size).toBe(pick.recipes.length)
    expect(pairs).toHaveLength(2)
    expect(new Set(pick.recipes.map(recipe => recipe.variant)).size).toBe(2)
  })

  it('leaves out dropped elements and exploits winners', () => {
    const recipes = buildStaticRecipes(input())
    const dropped = elementRecords([], [{ element_kind: 'variant', element_key: 'text', dropped: true }])
    expect(pickStaticBatch(recipes, { size: 10, records: dropped }).recipes.every(recipe => recipe.variant !== 'text')).toBe(true)
    const won = elementRecords([{ element_kind: 'static_format', element_key: 'SF02', score: 'winner' }])
    const pick = pickStaticBatch(recipes, { size: 2, records: won, exploitShare: 0.5 })
    expect(pick.exploit).toBe(1)
    expect(pick.recipes[0]!.format).toBe('SF02')
  })
})

describe('the static plan', () => {
  it('is only there for a shoot with static formats', () => {
    const base = { shoot: { slot_values: {} }, brand: { name: 'Brand' }, product: { name: 'Chews' }, channels: [] }
    expect(buildStaticPlan(base)).toBeNull()
    expect(buildStaticPlan({ ...base, statics: { formats: [], copies: [], stills: [] } })).toBeNull()
  })
})
