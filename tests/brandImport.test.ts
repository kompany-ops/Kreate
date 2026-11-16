import { describe, expect, it } from 'vitest'
import { createFields, parseCsv, parseScrybeCsv, payTypes, planImport, updateFields } from '../shared/utils/brandImport'

const HEADER = 'name,trybe link,trybe brand id,matched,match notes,pay types,commission %,ad spend %,flat per video $,flat per order $,retainer $,cap $,pay terms,trybe score,rating,reviews,creator earnings,total creators,categories,new,samples,top products,about,logo,scanned on'

// The example row from Scrybe's CSV export spec (format version 2)
const SPLIT_PAY = 'Split Pay,,449ca726-4aba-4463-a167-88a184fcf811,no,flat fee $15 < $20,% of ad spend; Flat per video,10,7,15,,,1000,"7% of ad spend (max $1000.00 per submission, Videos only) | $15.00 per submission (Videos only)",68,4.7,17,$80K+,30,Finance & Investing; Professional Development; Finance Apps,,,,,https://cdn.trybe.example/logos/449ca726.png,2026-10-14'

const file = (...rows: string[]) => `﻿${[HEADER, ...rows].join('\r\n')}\r\n`

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\r\nlines"\r\n1,2,3,4\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\r\nlines'],
      ['1', '2', '3', '4']
    ])
  })

  it('strips the byte-order mark and ignores blank lines', () => {
    expect(parseCsv('﻿name\r\n\r\nPawCo\n')).toEqual([['name'], ['PawCo']])
  })
})

describe('parseScrybeCsv', () => {
  it('reads the spec example row', () => {
    const { brands, errors } = parseScrybeCsv(file(SPLIT_PAY))
    expect(errors).toEqual([])
    expect(brands).toHaveLength(1)
    const brand = brands[0]!
    expect(brand).toMatchObject({
      name: 'Split Pay',
      trybe_url: null,
      trybe_brand_id: '449ca726-4aba-4463-a167-88a184fcf811',
      pay_types: ['flat', 'commission', 'ad_spend'],
      flat_fee: 15,
      commission_pct: 10,
      ad_spend_pct: 7,
      currency: 'USD',
      trybe_score: 68
    })
    expect(brand.trybe_data).toMatchObject({
      matched: 'no',
      match_notes: ['flat fee $15 < $20'],
      pay_types: ['% of ad spend', 'Flat per video'],
      ad_spend_pct: 7,
      cap: 1000,
      pay_terms: ['7% of ad spend (max $1000.00 per submission, Videos only)', '$15.00 per submission (Videos only)'],
      rating: 4.7,
      reviews: 17,
      creator_earnings: '$80K+',
      total_creators: 30,
      categories: ['Finance & Investing', 'Professional Development', 'Finance Apps'],
      new: null,
      samples: null,
      logo: 'https://cdn.trybe.example/logos/449ca726.png',
      scanned_on: '2026-10-14'
    })
  })

  it('treats empty cells as unknown, never zero', () => {
    const { brands } = parseScrybeCsv(file('Not Scanned Yet,,,unknown,trybe score,,,,,,,,,,,,,,,,,,,,'))
    expect(brands[0]).toMatchObject({ pay_types: [], flat_fee: null, commission_pct: null, trybe_score: null })
    expect(brands[0]!.trybe_data).toMatchObject({ matched: 'unknown', cap: null, scanned_on: null })
  })

  it('reads a "none" cap and undoes the formula guard', () => {
    const { brands } = parseScrybeCsv(file(`'=Equals Co,,,yes,,,,,,,,none,,,,,,,,yes,no,,"'-dash, about",,`))
    expect(brands[0]!.name).toBe('=Equals Co')
    expect(brands[0]!.trybe_data).toMatchObject({ cap: 'none', new: true, samples: false, about: '-dash, about' })
  })

  it('matches columns by header name, not position', () => {
    const { brands } = parseScrybeCsv('trybe score,name\r\n55,Reordered\r\n')
    expect(brands[0]).toMatchObject({ name: 'Reordered', trybe_score: 55 })
  })

  it('skips rows without a name and duplicate rows, and says so', () => {
    // a row of only commas is a blank line and is ignored silently; a row with data but no name is reported
    const { brands, errors } = parseScrybeCsv(file(SPLIT_PAY, ',,some-id,yes,,,,,,,,,,,,,,,,,,,,,', SPLIT_PAY, ',,,,,,,,,,,,,,,,,,,,,,,,'))
    expect(brands).toHaveLength(1)
    expect(errors).toEqual([
      'Row 3 has no brand name, so it was skipped.',
      'Row 4 (Split Pay) is a duplicate of an earlier row, so it was skipped.'
    ])
  })

  it('reads a version 1 export: its column names and "15% GMV" / "$50/video" style values', () => {
    // header and value shapes from a real version 1 export (scrybe-brands-2026-10-14.csv)
    const v1 = [
      'name,link,pay type,rate,flat fee,cap,category,new,samples,matched,rating,reviews,earnings,total creators,trybe score,website,top formats,top products,about,logo',
      'King Lou Pets,unknown,% of GMV/sales,15% GMV,unknown,unknown,Pet Supplies • Wellness Products • Pets,unknown,unknown,yes,4.6,9,$10K+,1000,35,unknown,unknown,whole duck feet; whole chicken feet,King Lou is a fast-growing premium pet brand...,https://jointrybe.com/_next/image?url=https%3A%2F%2Fcdn.jointrybe.com%2Fbrands%2F4a76e9e3-9dad-4303-9888-e88e66704e8b%2Flogos%2F1786.png&w=3840&q=75',
      'Both Pays,unknown,% of ad spend + Flat per video,5% ad spend,"$5,000/video","$10,000",Pets,yes,unknown,yes,unknown,unknown,unknown,unknown,unknown,unknown,unknown,,,',
      'Per Order Co,unknown,Flat per order,unknown,$10/order,unknown,Pets,unknown,unknown,yes,,,,,,unknown,unknown,,,'
    ].join('\r\n')
    const { brands, errors } = parseScrybeCsv(v1)
    expect(errors).toEqual([])

    expect(brands[0]).toMatchObject({
      name: 'King Lou Pets',
      trybe_url: null,
      trybe_brand_id: '4a76e9e3-9dad-4303-9888-e88e66704e8b',
      pay_types: ['commission'],
      commission_pct: 15,
      trybe_score: 35
    })
    expect(brands[0]!.trybe_data).toMatchObject({
      pay_types: ['% of GMV/sales'],
      categories: ['Pet Supplies', 'Wellness Products', 'Pets'],
      creator_earnings: '$10K+',
      total_creators: 1000,
      top_products: ['whole duck feet', 'whole chicken feet'],
      cap: null
    })

    expect(brands[1]).toMatchObject({ pay_types: ['flat', 'ad_spend'], flat_fee: 5000, commission_pct: null, ad_spend_pct: 5 })
    expect(brands[1]!.trybe_data).toMatchObject({
      pay_types: ['% of ad spend', 'Flat per video'],
      ad_spend_pct: 5,
      flat_per_video: 5000,
      cap: 10000,
      new: true
    })

    expect(brands[2]).toMatchObject({ pay_types: ['flat'], flat_fee: null })
    expect(brands[2]!.trybe_data.flat_per_order).toBe(10)
  })

  it('reads a future version with renamed headers and keeps columns it does not know', () => {
    const csv = [
      'Brand Name,Commission (%),Ad Spend Rate,Cap (USD),Pay Type,Categories,Scanned,TikTok Shop,Website',
      'Future Co,12.5%,"$1,000","$2,500",% of GMV/sales | Retainer,Pets | Treats,2026-11-02T09:15:00Z,yes,unknown',
      'Second Co,,,,,,,,'
    ].join('\n')
    const { brands, errors } = parseScrybeCsv(csv)
    expect(brands).toHaveLength(2)
    expect(errors).toEqual(['Kept as extra Trybe data on each brand: TikTok Shop.'])
    expect(brands[0]).toMatchObject({ name: 'Future Co', commission_pct: 12.5, pay_types: ['retainer', 'commission', 'ad_spend'], ad_spend_pct: null })
    expect(brands[0]!.trybe_data).toMatchObject({
      ad_spend_pct: 1000,
      cap: 2500,
      pay_types: ['% of GMV/sales', 'Retainer'],
      categories: ['Pets', 'Treats'],
      scanned_on: '2026-11-02',
      extra: { 'TikTok Shop': 'yes' }
    })
    // an empty unknown column is not stored
    expect(brands[1]!.trybe_data.extra).toEqual({})
  })

  it('rejects files that are not brand exports', () => {
    expect(parseScrybeCsv('title,colour\r\nA,\r\n').errors[0]).toMatch(/No brand name column/)
    expect(parseScrybeCsv('').errors).toEqual(['The file is empty.'])
  })
})

describe('payTypes', () => {
  const none = { pay_types: [], commission_pct: null, ad_spend_pct: null, flat_per_video: null, flat_per_order: null, retainer: null }
  it('maps Scrybe pay figures and labels to flat fee, retainer, commission and ad spend', () => {
    expect(payTypes({ ...none, flat_per_video: 15 })).toEqual(['flat'])
    expect(payTypes({ ...none, retainer: 500 })).toEqual(['retainer'])
    expect(payTypes({ ...none, ad_spend_pct: 7 })).toEqual(['ad_spend'])
    expect(payTypes({ ...none, commission_pct: 10, flat_per_order: 2 })).toEqual(['flat', 'commission'])
    expect(payTypes({ ...none, pay_types: ['% of GMV/sales'] })).toEqual(['commission'])
    expect(payTypes({ ...none, pay_types: ['% of ad spend', 'Retainer'] })).toEqual(['retainer', 'ad_spend'])
    expect(payTypes(none)).toEqual([])
  })
})

describe('planImport', () => {
  const imported = parseScrybeCsv(file(
    SPLIT_PAY,
    'PawCo,https://trybe.example/creator/discover?brand=abc,abc,yes,,,,,,,,,,90,,,,,,,,,,,',
    'Calming Co,,,yes,,,,,,,,,,,,,,,,,,,,,',
    'Calming Co!,,,yes,,,,,,,,,,,,,,,,,,,,,'
  )).brands

  const existing = [
    { id: 'b1', name: 'Paw Co (old name)', slug: 'pawco', trybe_brand_id: 'abc' },
    { id: 'b2', name: 'split pay', slug: 'split-pay-ltd', trybe_brand_id: null },
    { id: 'b3', name: 'Someone Else', slug: 'calming-co', trybe_brand_id: null }
  ]

  it('matches by Trybe brand ID, then by name, and creates the rest as prospects with free slugs', () => {
    const plan = planImport(imported, existing)
    expect(plan.updates.map(update => [update.id, update.brand.name])).toEqual([['b2', 'Split Pay'], ['b1', 'PawCo']])
    expect(plan.creates.map(brand => [brand.name, brand.slug])).toEqual([['Calming Co', 'calming-co-2'], ['Calming Co!', 'calming-co-3']])
    // the brand, and its deal (the team's only) apart from it
    expect(createFields(plan.creates[0]!)).toMatchObject({ brand: { status: 'prospect', slug: 'calming-co-2' }, deal: { currency: 'USD' } })
    expect(createFields(plan.creates[0]!).brand).not.toHaveProperty('pay_types')
  })

  it('refreshes Trybe fields on existing brands without blanking values Scrybe could not read', () => {
    const plan = planImport(imported, existing)
    const pawco = plan.updates.find(update => update.id === 'b1')!
    const { brand: fields, deal } = updateFields(pawco.brand)
    expect(fields).toMatchObject({ trybe_url: 'https://trybe.example/creator/discover?brand=abc', trybe_brand_id: 'abc', trybe_score: 90 })
    expect(fields).not.toHaveProperty('pay_types')
    expect(fields).not.toHaveProperty('name')
    expect(fields).not.toHaveProperty('status')
    // Scrybe couldn't read how PawCo pays: its deal is left as it is
    expect(deal).toBeNull()
  })
})
