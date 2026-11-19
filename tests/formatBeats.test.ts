import { describe, expect, it } from 'vitest'
import { formatBeatColumns } from '../shared/utils/formatBeats'

describe('formatBeatColumns', () => {
  it('writes a new modular format out in full', () => {
    const columns = formatBeatColumns('modular', [
      { beat: 'Problem', guidance: ' The pain ', show: 'face' },
      { beat: 'product', example: 'I use {{product}}', broll: ['Pouring it'] }
    ], null)
    expect(columns.beats).toEqual(['problem', 'product'])
    expect(columns.beat_descriptions).toEqual({ problem: 'The pain' })
    expect(columns.beat_examples).toEqual({ product: 'I use {{product}}' })
    expect(columns.beat_display).toEqual({ problem: 'face', product: 'broll' })
    expect(columns.beat_broll).toEqual({ product: [{ description: 'Pouring it' }] })
  })

  it('gives a standalone format its hook and cta, on camera, and never over b-roll', () => {
    const columns = formatBeatColumns('standalone', [{ beat: 'story' }], null)
    expect(columns.beats).toEqual(['hook', 'story', 'cta'])
    expect(columns.beat_display).toEqual({ hook: 'face', story: 'broll', cta: 'face' })
    expect(() => formatBeatColumns('standalone', [{ beat: 'hook', show: 'broll' }, { beat: 'story' }], null)).toThrow(/never over b-roll/)
    expect(() => formatBeatColumns('standalone', [{ beat: 'hook' }, { beat: 'cta' }], null)).toThrow(/at least one beat/)
  })

  it('keeps what a beat had unless it is given anew, and drops beats that go', () => {
    const current = {
      kind: 'modular',
      beats: ['problem', 'product', 'result'],
      beat_descriptions: { problem: 'Old pain', result: 'After' },
      beat_examples: {},
      beat_display: { problem: 'face', product: 'broll', result: 'broll' },
      beat_broll: { product: [{ description: 'Pack shot' }] }
    }
    const columns = formatBeatColumns('modular', [{ beat: 'problem' }, { beat: 'product', guidance: 'Show it' }], current)
    expect(columns.beats).toEqual(['problem', 'product'])
    expect(columns.beat_descriptions).toEqual({ problem: 'Old pain', product: 'Show it' })
    expect(columns.beat_display).toEqual({ problem: 'face', product: 'broll' })
    expect(columns.beat_broll).toEqual({ product: [{ description: 'Pack shot' }] })
    // switching class with the beats left as they are adds the hook and cta, or drops them
    expect(formatBeatColumns('standalone', undefined, current).beats).toEqual(['hook', 'problem', 'product', 'result', 'cta'])
    expect(formatBeatColumns('modular', undefined, { ...current, kind: 'standalone', beats: ['hook', 'story', 'cta'] }).beats).toEqual(['story'])
  })
})
