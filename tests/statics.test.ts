import { describe, expect, it } from 'vitest'
import {
  cleanKitColors, cleanKitFonts, kitHex, parseBrandKit,
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
