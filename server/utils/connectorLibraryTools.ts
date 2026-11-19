import * as z from 'zod/v4'
import type { Insert, Update } from '#shared/types/models'
import type { ShootToolKit } from './connectorShootTools'

// The AI connector's Library and product editing tools: formats (add and change), changing hooks,
// CTAs and products, the way the Library and brand pages do. Linked items (a partner brand's,
// `source_id` set) are the partner's and can't be changed here, as in the app; the database
// guards them too.

export interface LibraryToolKit extends Omit<ShootToolKit, 'paths'> {
  paths: { format: (id: string) => string, hook: (id: string) => string, cta: (id: string) => string, product: (brandId: string, id: string) => string }
}

const check = <T>(result: { data: T, error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const LINKED = 'It\'s linked in from a partner brand, so only that brand can change it.'

const SHOW_VALUES = ['face', 'broll', 'screen', 'voice_note'] as const

const beatInput = z.object({
  beat: z.string().min(1).max(60).describe('The beat\'s name, e.g. problem, product, result (lowercase). A standalone format\'s first beat is always "hook" and its last "cta": they\'re added if you leave them out.'),
  guidance: z.string().max(1000).optional().describe('What to write in this beat'),
  example: z.string().max(1000).optional().describe('An example line'),
  show: z.enum(SHOW_VALUES).optional().describe('How it\'s shown: face (on camera), broll (voice over b-roll; the default, but never for a standalone hook or cta, which default to face), screen (a text message, not filmed) or voice_note'),
  broll: z.array(z.string().min(1).max(300)).max(20).optional().describe('Suggested b-roll shots for this beat')
})
type BeatInput = z.infer<typeof beatInput>

const formatInputs = {
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional().describe('What the format is (null clears)'),
  kind: z.enum(['modular', 'standalone']).optional().describe('modular: a Library hook + this VO + a Library CTA (the default). standalone: opens and closes itself with its own hook and cta beats.'),
  beats: z.array(beatInput).min(1).max(20).optional().describe('Every beat, in order, replacing the current ones. A beat you name that the format already has keeps its guidance, example, show and b-roll unless you give new ones.'),
  target_seconds: z.number().int().min(1).max(600).nullable().optional().describe('How long a video in it should run'),
  source_url: z.string().url().max(500).nullable().optional().describe('Where the idea came from'),
  brand_id: z.string().uuid().nullable().optional().describe('Only for this brand\'s shoots (from list_brands); null makes it general')
}
type FormatInput = {
  name?: string, description?: string | null, kind?: 'modular' | 'standalone', beats?: BeatInput[],
  target_seconds?: number | null, source_url?: string | null, brand_id?: string | null, organisation?: string
}
export function registerLibraryTools(kit: LibraryToolKit) {
  const { server, guarded, text, failure, link, paths, pace, organisationArg } = kit

  async function brandOrError(db: ConnectorDb, brandId: string | null | undefined) {
    if (!brandId) return null
    const brand = check(await db.from('brands').select('id, name, source_brand_id').eq('id', brandId).maybeSingle())
    if (!brand) throw new Error('That brand isn\'t in this organisation. Use an id from list_brands.')
    if (brand.source_brand_id) throw new Error(`${brand.name} is a partner's brand: its Library is theirs, so your own items can't be scoped to it.`)
    return brand
  }

  const describeFormat = (row: { id: string, code: string, name: string, kind: string, beats: string[], archived: boolean }) =>
    ({ code: row.code, name: row.name, kind: row.kind, beats: row.beats, archived: row.archived, link: link(paths.format(row.id)) })

  // --- formats ------------------------------------------------------------------------------------
  server.registerTool('add_format', {
    title: 'Add format',
    description: 'Add a format (a VO structure) to the Library: its beats in order, with what to write in each, an example line, how it\'s shown and suggested b-roll. Check get_library (kind formats) first so it isn\'t a duplicate. Follow the voice and script rules from get_workspace in the guidance and examples.',
    inputSchema: z.object({
      code: z.string().regex(/^[Ff]\d{1,4}$/).optional().describe('Its code, e.g. F07. Leave out for the next free one.'),
      ...formatInputs,
      name: z.string().min(1).max(120),
      beats: formatInputs.beats.unwrap(),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: FormatInput & { code?: string, name: string, beats: BeatInput[] }, org, db) => {
    const existing = check(await db.from('formats').select('code, name')) ?? []
    const code = input.code
      ? input.code.trim().toUpperCase()
      : `F${String(Math.max(0, ...existing.map(row => Number(row.code.match(/^F(\d+)$/)?.[1] ?? 0))) + 1).padStart(2, '0')}`
    const taken = existing.find(row => row.code === code)
    if (taken) return failure(`${code} is already ${taken.name}. Leave the code out for the next free one.`)
    const named = existing.find(row => same(row.name, input.name))
    if (named) return failure(`There's already a format called ${named.name} (${named.code}). Change it with update_format, or give this one another name.`)
    const brand = await brandOrError(db, input.brand_id)
    const row = check(await db.from('formats').insert({
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      ...formatBeatColumns(input.kind ?? 'modular', input.beats, null),
      target_seconds: input.target_seconds ?? null,
      source_url: input.source_url ? input.source_url.trim() : null,
      brand_id: brand?.id ?? null
    } as unknown as Insert<'formats'>).select('id, code, name, kind, beats, archived').single())!
    return text({ added: 'format', organisation: org.name, ...describeFormat(row), for_brand: brand?.name ?? 'any brand', next: 'Write VOs in it with add_vo, on a shoot that has it (update_shoot adds formats to a draft).' })
  }))

  server.registerTool('update_format', {
    title: 'Update format',
    description: 'Change a format: its name, description, class, beats (with guidance, examples, how each is shown and b-roll), target length, source, brand, or archive or restore it. Only what you pass changes. Shoots already planned keep the beats they were planned with; VOs written in it keep their words, so renaming or removing a beat leaves those VOs to be rewritten. Confirm with the person before archiving or removing beats.',
    inputSchema: z.object({
      format: z.string().min(1).max(20).describe('The format code, e.g. F03'),
      ...formatInputs,
      archived: z.boolean().optional().describe('true archives it (hidden from new shoots; its VOs stay), false restores it'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: FormatInput & { format: string, archived?: boolean }, org, db) => {
    const current = check(await db.from('formats').select('*').eq('code', input.format.trim().toUpperCase()).maybeSingle())
    if (!current) return failure(`There's no format ${input.format}. Use a code from get_library (kind formats).`)
    if (current.source_id) return failure(`${current.code} ${LINKED}`)
    const fields: Record<string, unknown> = {}
    if (input.name?.trim()) {
      const named = check(await db.from('formats').select('code, name').neq('id', current.id).ilike('name', input.name.trim()).maybeSingle())
      if (named) return failure(`${named.code} is already called ${named.name}.`)
      fields.name = input.name.trim()
    }
    if (input.description !== undefined) fields.description = input.description?.trim() || null
    if (input.target_seconds !== undefined) fields.target_seconds = input.target_seconds
    if (input.source_url !== undefined) fields.source_url = input.source_url ? input.source_url.trim() : null
    if (input.brand_id !== undefined) fields.brand_id = (await brandOrError(db, input.brand_id))?.id ?? null
    if (input.archived !== undefined) fields.archived = input.archived
    const beatsTouched = input.beats !== undefined || (input.kind !== undefined && input.kind !== current.kind)
    const removedBeats: string[] = []
    if (beatsTouched) {
      const columns = formatBeatColumns(input.kind ?? (current.kind === 'standalone' ? 'standalone' : 'modular'), input.beats, current)
      Object.assign(fields, columns)
      removedBeats.push(...current.beats.filter(beat => !columns.beats.includes(beat)))
    }
    if (!Object.keys(fields).length) return failure('Nothing to change: pass what should change.')
    check(await db.from('formats').update(fields as Update<'formats'>).eq('id', current.id))
    const row = check(await db.from('formats').select('id, code, name, kind, beats, archived').eq('id', current.id).single())!
    const vos = removedBeats.length
      ? (check(await db.from('body_templates').select('id').eq('format_id', current.id).eq('archived', false)) ?? []).length
      : 0
    return text({
      updated: 'format',
      organisation: org.name,
      changed: Object.keys(fields),
      ...describeFormat(row),
      ...(vos ? { note: `${vos} VO${vos === 1 ? ' was' : 's were'} written with the beats you removed (${removedBeats.join(', ')}): update them (update_vo) before they go on a shoot.` } : {})
    })
  }))

  // --- hooks and CTAs -------------------------------------------------------------------------------
  const scopeInput = z.string().uuid().nullable().optional()
    .describe('Only for this product (from list_brands); null makes it general. Leave out to keep it as it is.')
  const tagsInput = z.array(z.string().max(40)).max(12).optional().describe('Its tags, replacing the current ones (keep "ai-draft" until a person has reviewed it)')
  const libraryCommon = {
    notes: z.string().max(2000).nullable().optional(),
    source_url: z.string().url().max(500).nullable().optional(),
    tags: tagsInput,
    product_id: scopeInput,
    archived: z.boolean().optional().describe('true archives it (hidden from new shoots), false restores it')
  }
  type CommonInput = { notes?: string | null, source_url?: string | null, tags?: string[], product_id?: string | null, archived?: boolean }

  async function commonFields(db: ConnectorDb, input: CommonInput, wps: number, script: string | undefined) {
    const fields: Record<string, unknown> = {}
    if (script !== undefined) {
      fields.script = script.trim()
      fields.est_seconds = estimateSeconds(script, wps)
    }
    if (input.notes !== undefined) fields.notes = input.notes?.trim() || null
    if (input.source_url !== undefined) fields.source_url = input.source_url ? input.source_url.trim() : null
    if (input.tags !== undefined) fields.tags = [...new Set(input.tags.map(slugify).filter(Boolean))]
    if (input.archived !== undefined) fields.archived = input.archived
    if (input.product_id !== undefined) {
      if (input.product_id) {
        const product = check(await db.from('products').select('id, source_product_id').eq('id', input.product_id).maybeSingle())
        if (!product) throw new Error('That product isn\'t in this organisation. Use an id from list_brands.')
        if (product.source_product_id) throw new Error('That product is a partner brand\'s: its Library is theirs.')
      }
      Object.assign(fields, { product_id: input.product_id, brand_id: null })
    }
    return fields
  }

  server.registerTool('update_hooks', {
    title: 'Update hooks',
    description: 'Change Library hooks (ids from get_library or search_library): wording, caption, hook type, filming notes, notes, tags, product, or archive or restore them. Only what you pass changes. Shoots already planned keep the wording they were planned with. Confirm with the person before archiving.',
    inputSchema: z.object({
      hooks: z.array(z.object({
        id: z.string().uuid(),
        script: z.string().min(1).max(500).optional().describe('The line, with slots'),
        caption: z.string().max(500).nullable().optional(),
        hook_type: z.string().max(80).nullable().optional().describe('A hook type name from get_workspace; null clears it'),
        filming_notes: z.string().max(2000).nullable().optional(),
        ...libraryCommon
      })).min(1).max(50),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ hooks }: { hooks: (CommonInput & { id: string, script?: string, caption?: string | null, hook_type?: string | null, filming_notes?: string | null })[], organisation?: string }, org, db) => {
    const rows = check(await db.from('hook_templates').select('id, shoot_id, source_id').in('id', hooks.map(hook => hook.id))) ?? []
    const types = check(await db.from('angles').select('id, name').eq('archived', false)) ?? []
    const wps = await pace(db)
    const done: { id: string, changed: string[], link: string }[] = []
    const problems: string[] = []
    for (const hook of hooks) {
      const row = rows.find(entry => entry.id === hook.id)
      if (!row) { problems.push(`${hook.id}: not a hook here`); continue }
      if (row.source_id) { problems.push(`${hook.id}: ${LINKED}`); continue }
      if (row.shoot_id) { problems.push(`${hook.id}: it's one shoot's own hook; change its wording with edit_shot_list`); continue }
      try {
        const fields = await commonFields(db, hook, wps, hook.script)
        if (hook.caption !== undefined) fields.caption = hook.caption?.trim() || null
        if (hook.filming_notes !== undefined) fields.filming_notes = hook.filming_notes?.trim() || null
        if (hook.hook_type !== undefined) {
          const type = hook.hook_type ? types.find(entry => same(entry.name, hook.hook_type!)) : null
          if (hook.hook_type && !type) throw new Error(`there's no hook type "${hook.hook_type}" (get_workspace lists them)`)
          fields.angle_id = type?.id ?? null
        }
        if (!Object.keys(fields).length) { problems.push(`${hook.id}: nothing to change`); continue }
        check(await db.from('hook_templates').update(fields as Update<'hook_templates'>).eq('id', hook.id))
        done.push({ id: hook.id, changed: Object.keys(fields), link: link(paths.hook(hook.id)) })
      } catch (caught) {
        problems.push(`${hook.id}: ${caught instanceof Error ? caught.message : 'failed'}`)
      }
    }
    return text({ updated: done.length, organisation: org.name, hooks: done, ...(problems.length ? { not_changed: problems } : {}) })
  }))

  server.registerTool('update_ctas', {
    title: 'Update CTAs',
    description: 'Change Library CTAs (ids from get_library or search_library): wording, mode (sync on camera, vo voiceover), notes, tags, product, or archive or restore them. Only what you pass changes. Shoots already planned keep the wording they were planned with. Confirm with the person before archiving.',
    inputSchema: z.object({
      ctas: z.array(z.object({
        id: z.string().uuid(),
        script: z.string().min(1).max(500).optional(),
        mode: z.enum(['sync', 'vo']).optional(),
        ...libraryCommon
      })).min(1).max(50),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ ctas }: { ctas: (CommonInput & { id: string, script?: string, mode?: 'sync' | 'vo' })[], organisation?: string }, org, db) => {
    const rows = check(await db.from('cta_templates').select('id, shoot_id, source_id').in('id', ctas.map(cta => cta.id))) ?? []
    const wps = await pace(db)
    const done: { id: string, changed: string[], link: string }[] = []
    const problems: string[] = []
    for (const cta of ctas) {
      const row = rows.find(entry => entry.id === cta.id)
      if (!row) { problems.push(`${cta.id}: not a CTA here`); continue }
      if (row.source_id) { problems.push(`${cta.id}: ${LINKED}`); continue }
      if (row.shoot_id) { problems.push(`${cta.id}: it's one shoot's own CTA; change its wording with edit_shot_list`); continue }
      try {
        const fields = await commonFields(db, cta, wps, cta.script)
        if (cta.mode !== undefined) fields.mode = cta.mode
        if (!Object.keys(fields).length) { problems.push(`${cta.id}: nothing to change`); continue }
        check(await db.from('cta_templates').update(fields as Update<'cta_templates'>).eq('id', cta.id))
        done.push({ id: cta.id, changed: Object.keys(fields), link: link(paths.cta(cta.id)) })
      } catch (caught) {
        problems.push(`${cta.id}: ${caught instanceof Error ? caught.message : 'failed'}`)
      }
    }
    return text({ updated: done.length, organisation: org.name, ctas: done, ...(problems.length ? { not_changed: problems } : {}) })
  }))

  // --- products -----------------------------------------------------------------------------------
  server.registerTool('update_product', {
    title: 'Update product',
    description: 'Change a product (from list_brands): its name, allowed and forbidden claims (be conservative: only what the brand says), notes, and its features: rename them or change their descriptions, remove them, or reorder them. Only what you pass changes; add new features with add_features. A feature a VO or b-roll shot is about can\'t be removed (rename it instead). Confirm with the person before removing features or loosening claims.',
    inputSchema: z.object({
      product_id: z.string().uuid().describe('The product (from list_brands)'),
      name: z.string().min(1).max(120).optional(),
      claims_allowed: z.string().max(4000).nullable().optional().describe('Replaces what\'s there (null clears)'),
      claims_forbidden: z.string().max(4000).nullable().optional().describe('Replaces what\'s there (null clears)'),
      notes: z.string().max(4000).nullable().optional(),
      update_features: z.array(z.object({
        name: z.string().min(1).max(120).describe('The feature\'s current name'),
        new_name: z.string().min(1).max(120).optional(),
        description: z.string().max(1000).nullable().optional()
      })).max(20).optional(),
      remove_features: z.array(z.string().min(1).max(120)).max(20).optional().describe('Names of features to remove'),
      feature_order: z.array(z.string().min(1).max(120)).max(50).optional().describe('Feature names in the order they should be listed (any left out go after, as they are)'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, guarded(async (input: {
    product_id: string, name?: string, claims_allowed?: string | null, claims_forbidden?: string | null, notes?: string | null,
    update_features?: { name: string, new_name?: string, description?: string | null }[], remove_features?: string[], feature_order?: string[], organisation?: string
  }, org, db) => {
    const product = check(await db.from('products').select('id, name, brand_id, source_product_id, product_features(id, name, description, sort_order)').eq('id', input.product_id).maybeSingle())
    if (!product) return failure('That product isn\'t in this organisation. Use an id from list_brands.')
    if (product.source_product_id) return failure(`${product.name} ${LINKED}`)
    let features = [...product.product_features].sort((a, b) => a.sort_order - b.sort_order)
    const find = (name: string) => {
      const feature = features.find(entry => same(entry.name, name))
      if (!feature) throw new Error(`${product.name} has no feature called "${name}". It has ${features.map(entry => entry.name).join(', ') || 'none'}.`)
      return feature
    }
    const changed: string[] = []

    // check everything before writing anything
    const removing = (input.remove_features ?? []).map(find)
    const updating = (input.update_features ?? []).map(entry => ({ feature: find(entry.name), ...entry }))
    if (removing.length) {
      const ids = removing.map(feature => feature.id)
      const [vos, shots] = await Promise.all([
        db.from('body_templates').select('feature_id, shoot:shoots(code)').in('feature_id', ids),
        db.from('broll_shots').select('feature_id, shoot:shoots(code)').in('feature_id', ids)
      ])
      const codeOf = (shoot: unknown) => ((Array.isArray(shoot) ? shoot[0] : shoot) as { code?: string } | null)?.code ?? 'no shoot'
      const inUse = removing.map((feature) => {
        const uses = [...(check(vos) ?? []).map(row => ({ ...row, what: 'VO' })), ...(check(shots) ?? []).map(row => ({ ...row, what: 'b-roll shot' }))].filter(row => row.feature_id === feature.id)
        return uses.length ? `"${feature.name}" is used by ${uses.length} VO${uses.length === 1 ? '' : 's'} or b-roll shot${uses.length === 1 ? '' : 's'} (${[...new Set(uses.map(row => codeOf(row.shoot)))].sort().join(', ')})` : ''
      }).filter(Boolean)
      if (inUse.length) return failure(`${inUse.join('. ')}. Move them to another feature or remove them first; renaming the feature is fine. Nothing was changed.`)
    }
    const finalNames = features.filter(feature => !removing.includes(feature)).map(feature => updating.find(entry => entry.feature.id === feature.id)?.new_name?.trim() ?? feature.name)
    const dupes = finalNames.filter((name, index) => finalNames.findIndex(other => same(other, name)) !== index)
    if (dupes.length) return failure(`Two features would be called ${dupes[0]}. Nothing was changed.`)

    const fields: Record<string, unknown> = {}
    if (input.name?.trim() && input.name.trim() !== product.name) {
      const taken = check(await db.from('products').select('name').eq('brand_id', product.brand_id).neq('id', product.id).ilike('name', input.name.trim()).maybeSingle())
      if (taken) return failure(`The brand already has a product called ${taken.name}. Nothing was changed.`)
      fields.name = input.name.trim()
    }
    if (input.claims_allowed !== undefined) fields.claims_allowed = input.claims_allowed?.trim() || null
    if (input.claims_forbidden !== undefined) fields.claims_forbidden = input.claims_forbidden?.trim() || null
    if (input.notes !== undefined) fields.notes = input.notes?.trim() || null
    if (Object.keys(fields).length) {
      check(await db.from('products').update(fields as Update<'products'>).eq('id', product.id))
      changed.push(...Object.keys(fields))
    }

    if (removing.length) {
      check(await db.from('product_features').delete().in('id', removing.map(feature => feature.id)))
      features = features.filter(feature => !removing.includes(feature))
      changed.push(`removed ${removing.map(feature => feature.name).join(', ')}`)
    }
    for (const entry of updating) {
      const values: Record<string, unknown> = {}
      if (entry.new_name?.trim()) values.name = entry.new_name.trim()
      if (entry.description !== undefined) values.description = entry.description?.trim() || null
      if (!Object.keys(values).length) continue
      check(await db.from('product_features').update(values as Update<'product_features'>).eq('id', entry.feature.id))
      changed.push(`feature ${entry.feature.name}`)
      if (values.name) entry.feature.name = values.name as string
    }
    if (input.feature_order?.length) {
      const ordered = input.feature_order.map(find)
      const rest = features.filter(feature => !ordered.includes(feature))
      for (const [index, feature] of [...ordered, ...rest].entries()) {
        if (feature.sort_order !== index) check(await db.from('product_features').update({ sort_order: index }).eq('id', feature.id))
      }
      changed.push('feature order')
    }
    if (!changed.length) return failure('Nothing to change: pass what should change.')
    const after = check(await db.from('products').select('id, name, claims_allowed, claims_forbidden, notes, product_features(name, description, sort_order)').eq('id', product.id).single())!
    return text({
      updated: 'product',
      organisation: org.name,
      changed,
      ...after,
      product_features: [...after.product_features].sort((a, b) => a.sort_order - b.sort_order).map(({ name, description }) => ({ name, description })),
      link: link(paths.product(product.brand_id, product.id))
    })
  }))
}
