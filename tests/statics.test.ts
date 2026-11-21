import { describe, expect, it } from 'vitest'
import {
  cleanKitColors, cleanKitFonts, kitHex, parseBrandKit,
  cleanCopySlots, copyCombinations, copyGaps, nextStaticCopyCode, parseCopySlots, renderCopy, staticBlockers, stillsNeeded, suggestedStills,
  cleanStaticRules, cleanStaticSlots, cleanStaticVariants, nextStaticFormatCode, parseStaticFormatsCsv,
  parseStaticReferences, parseStaticRules, parseStaticSlots, slotOverLimit, staticSlotKey, variantNeeds
} from '../shared/utils/statics'

describe('static format slots', () => {
  it('keys are snake case and start with a letter', () => {
    expect(staticSlotKey('Sub head')).toBe('sub_head')
    expect(staticSlotKey('  Price!! ')).toBe('price')
    expect(staticSlotKey('2nd line')).toBe('slot_2nd_line')
    expect(staticSlotKey('!!')).toBe('')
  })

  it('cleans slots for saving: keys from labels, blanks dropped, word limits whole', () => {
    expect(cleanStaticSlots([
      { label: 'Headline', max_words: 8.4, guidance: '  The hook  ', example: '' },
      { label: '', key: '' },
      { key: 'cta_line', label: '', required: false }
    ])).toEqual([
      { key: 'headline', label: 'Headline', max_words: 8, guidance: 'The hook', example: null, required: true },
      { key: 'cta_line', label: 'cta line', max_words: null, guidance: null, example: null, required: false }
    ])
  })

  it('refuses two slots with one key', () => {
    expect(() => cleanStaticSlots([{ label: 'Headline' }, { label: 'headline' }])).toThrow(/Two slots/)
  })

  it('reads stored slots leniently', () => {
    expect(parseStaticSlots([{ key: 'body', max_words: '0', extra: 1 }, 'nope', { label: 'no key' }])).toEqual([
      { key: 'body', label: 'body', max_words: null, guidance: null, example: null, required: true }
    ])
    expect(parseStaticSlots(null)).toEqual([])
  })

  it('warns when copy is over a slot\'s word limit', () => {
    expect(slotOverLimit({ max_words: 3 }, 'one two three')).toBeNull()
    expect(slotOverLimit({ max_words: 3 }, 'one two three four')).toBe('4 words, over the 3-word limit')
    expect(slotOverLimit({ max_words: null }, 'any length at all')).toBeNull()
  })
})

describe('static format fields', () => {
  it('rules and references read leniently and clean for saving', () => {
    expect(parseStaticRules({ always: ['Big type', ' '], never: 'x' })).toEqual({ always: ['Big type'], never: [] })
    expect(cleanStaticRules({ always: [' a ', 'a', ''], never: ['b'] })).toEqual({ always: ['a'], never: ['b'] })
    expect(parseStaticReferences([{ path: 'o/f/1.png', source_url: '' }, { nope: 1 }])).toEqual([{ path: 'o/f/1.png', source_url: null }])
  })

  it('variants keep their usual order and need at least one', () => {
    expect(cleanStaticVariants(['text_avatar', 'text', 'carousel'])).toEqual(['text', 'text_avatar'])
    expect(() => cleanStaticVariants([])).toThrow(/at least one variant/)
    expect(variantNeeds('text_product_avatar')).toEqual({ product: true, avatar: true })
    expect(variantNeeds('text')).toEqual({ product: false, avatar: false })
  })

  it('codes count on from the highest', () => {
    expect(nextStaticFormatCode([])).toBe('SF01')
    expect(nextStaticFormatCode(['SF01', 'SF09', 'F12'])).toBe('SF10')
  })
})

describe('static format CSV import', () => {
  it('reads one format per row, with variants and rules from plain words', () => {
    const csv = [
      'Name,Description,Variant text,Rules,Tags',
      'Notes app,"An iPhone note","text, text + product","Always big type; Never use a stock photo; Don\'t crop the notch",notes',
      ',skipped,,,',
      'Mirror note,Sticky note on a mirror,person,,'
    ].join('\n')
    const { formats, skipped } = parseStaticFormatsCsv(csv)
    expect(skipped).toBe(1)
    expect(formats).toEqual([
      {
        name: 'Notes app',
        description: 'An iPhone note',
        mechanism: null,
        variants: ['text', 'text_product'],
        rules: { always: ['big type'], never: ['use a stock photo', 'crop the notch'] },
        tags: ['notes']
      },
      { name: 'Mirror note', description: 'Sticky note on a mirror', mechanism: null, variants: ['text_avatar'], rules: { always: [], never: [] }, tags: [] }
    ])
  })

  it('defaults to text, and needs a name column', () => {
    expect(parseStaticFormatsCsv('name\nBanner').formats[0]!.variants).toEqual(['text'])
    expect(() => parseStaticFormatsCsv('title only?\nx')).toThrow(/Name column/)
  })
})

describe('brand kits', () => {
  it('reads colours as hex codes', () => {
    expect(kitHex('#F60')).toBe('#ff6600')
    expect(kitHex('ff6600')).toBe('#ff6600')
    expect(kitHex('orange')).toBeNull()
  })

  it('reads a stored kit leniently, and no kit as an empty one', () => {
    expect(parseBrandKit({
      colors: [{ name: 'Primary', hex: 'F60' }, { hex: 'nope' }],
      fonts: [{ role: 'headline', family: 'Inter', file: '' }, { role: 'caption', family: 'X' }],
      logos: [{ path: 'o/b/logos/1.png', use: 'weird' }],
      rules: { always: ['Lots of white space'] }
    })).toEqual({
      colors: [{ name: 'Primary', hex: '#ff6600' }],
      fonts: [{ role: 'headline', family: 'Inter', file: null }],
      logos: [{ path: 'o/b/logos/1.png', use: 'light' }],
      style_notes: null,
      rules: { always: ['Lots of white space'], never: [] },
      dropbox_path: null
    })
    expect(parseBrandKit(null).colors).toEqual([])
  })

  it('cleans colours and fonts for saving', () => {
    expect(cleanKitColors([{ name: '', hex: '#ABC' }, { name: '', hex: '' }])).toEqual([{ name: '#aabbcc', hex: '#aabbcc' }])
    expect(() => cleanKitColors([{ name: 'Brand', hex: 'orange' }])).toThrow(/isn't a colour/)
    expect(cleanKitFonts([{ role: 'body', family: ' Lora ' }, { role: 'headline', family: '' }])).toEqual([{ role: 'body', family: 'Lora', file: null }])
    expect(() => cleanKitFonts([{ role: 'body', family: 'A' }, { role: 'body', family: 'B' }])).toThrow(/already a body font/)
  })
})

describe('static copy', () => {
  const slots = [
    { key: 'headline', label: 'Headline', max_words: 6, guidance: null, example: null, required: true },
    { key: 'sub', label: 'Sub-head', max_words: null, guidance: null, example: null, required: false }
  ]

  it('cleans copy against its format: its slots in order, required ones filled, wordings tidy', () => {
    expect(cleanCopySlots(slots, [
      { slot: 'sub', text: '' },
      { slot: 'headline', text: ' My {{dog}} eats ', alternates: ['My {{dog}} eats', 'Dinner, solved', ' ', { text: 'Dinner, solved' }] }
    ])).toEqual([{ slot: 'headline', text: 'My {{dog}} eats', alternates: [{ text: 'Dinner, solved' }] }])
    expect(() => cleanCopySlots(slots, [{ slot: 'sub', text: 'x' }])).toThrow(/"Headline" needs copy/)
    expect(() => cleanCopySlots(slots, [{ slot: 'headline', text: 'x' }, { slot: 'price', text: '$5' }])).toThrow(/no price slot/)
  })

  it('counts wordings, finds gaps and numbers codes', () => {
    const copy = parseCopySlots([{ slot: 'headline', text: 'a', alternates: [{ text: 'b' }, { text: 'c' }] }, { slot: 'sub', text: 'd', alternates: [{ text: 'e' }] }])
    expect(copyCombinations(copy)).toBe(6)
    expect(copyGaps(slots, [{ slot: 'sub', text: 'x', alternates: [] }])).toEqual(['Headline'])
    expect(nextStaticCopyCode(['A01', 'A07'])).toBe('A08')
  })

  it('fills a copy for a channel and says what\'s left unfilled', () => {
    const copy = parseCopySlots([{ slot: 'headline', text: '{{dog}} loves {{product}}', alternates: [{ text: '{{offer}} today' }] }])
    expect(renderCopy(copy, { dog: 'Nix', product: 'Chews' })).toEqual({
      slots: [{ slot: 'headline', text: 'Nix loves Chews', alternates: ['{{offer}} today'] }],
      unfilled: ['offer']
    })
  })

  it('stops planning until each format has its copy and the stills its variants need', () => {
    const format = { id: 'f1', code: 'SF01', slots, variants: ['text', 'text_product'] }
    const bundle = {
      shoot: { slot_values: {} },
      brand: { name: 'Brand' },
      product: { name: 'Chews' },
      channels: [{ id: 'c1', name: 'topdognix', slot_values: { dog: 'Nix' } }],
      statics: { formats: [format], copies: [], stills: [] }
    } as unknown as Parameters<typeof staticBlockers>[0]
    expect(staticBlockers(bundle)).toEqual(['Write copy for SF01 (Statics)', 'Add product stills (Statics): a format has a product variant'])
    bundle.statics!.copies.push({ code: 'A01', static_format_id: 'f1', cast_channel_id: null, slots: [{ slot: 'headline', text: '{{offer}} for {{dog}}' }] } as never)
    bundle.statics!.stills.push({ kind: 'product' } as never)
    expect(staticBlockers(bundle)).toEqual(['Fill the slots in A01 (Statics)'])
  })

  it('suggests stills for what the variants show', () => {
    expect(stillsNeeded(['text', 'text_avatar'])).toEqual({ product: false, avatar: true })
    expect(suggestedStills('avatar', true)).toHaveLength(3)
    expect(suggestedStills('avatar', false)).toHaveLength(2)
  })
})
