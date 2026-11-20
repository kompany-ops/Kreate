import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { Json } from '#shared/types/database.types'
import type { Row, Update } from '#shared/types/models'
import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { ShotGroup } from '#shared/utils/shootsheet'
import type { Beat } from '#shared/utils/slots'
import type { ConnectorDb, ConnectorOrg, ToolResult } from './connectorTools'

// The AI connector's shoot tools: everything a person can change on a shoot's page, through the
// same shared code (shootPlan) and under the same rules (RLS, and the database's guards on who
// may do what at which status). Filming, uploads, editing and batches stay in Kreate and Klip.

export interface ShootToolKit {
  server: McpServer
  guarded: <A extends { organisation?: string }>(run: (args: A, org: ConnectorOrg, db: ConnectorDb) => Promise<ToolResult>) => (args: A) => Promise<ToolResult>
  text: (value: unknown) => ToolResult
  failure: (message: string) => ToolResult
  link: (path: string) => string
  paths: { shoot: (code: string) => string, vo: (code: string, id: string) => string, hook: (id: string) => string, cta: (id: string) => string }
  pace: (db: ConnectorDb) => Promise<number>
  organisationArg: z.ZodOptional<z.ZodString>
}

const STATUS_WORDS: Record<string, string> = { draft: 'a draft', planned: 'planned', shooting: 'being filmed', filmed: 'filmed', editing: 'being edited', edited: 'live' }
const KIND_WORDS: Record<string, string> = { hook: 'hook', body: 'VO', cta: 'CTA' }

const check = <T>(result: { data: T, error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
/** A list query's rows (never null). */
const list = <T>(result: { data: T[] | null, error: { message: string } | null }): T[] => check(result) ?? []
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Rows matched by name; any name that isn't one is an error listing what there is. */
function byNames<T extends { name: string }>(rows: T[], names: string[], what: string): T[] {
  const unknown = names.filter(name => !rows.some(row => same(row.name, name)))
  if (unknown.length) throw new Error(`No ${what} called ${unknown.map(name => `"${name}"`).join(', ')}. There's ${rows.map(row => row.name).join(', ') || 'none'}.`)
  return names.map(name => rows.find(row => same(row.name, name))!)
}

async function loadShoot(db: ConnectorDb, code: string): Promise<LoadedShoot> {
  const bundle = await loadShootBundle(db, code.trim().toUpperCase())
  if (!bundle) throw new Error(`There's no shoot ${code}. Use a code from list_shoots.`)
  return bundle
}

function requireDraft(bundle: LoadedShoot, what: string) {
  if (bundle.shoot.status === 'draft') return
  throw new Error(`${bundle.shoot.code} is ${STATUS_WORDS[bundle.shoot.status] ?? bundle.shoot.status}, so ${what} can't change. `
    + (bundle.shoot.status === 'planned' ? 'Someone on the team can move it back to draft first (set_shoot_status draft).' : 'Its plan is frozen.'))
}
function requireNotLive(bundle: LoadedShoot) {
  if (bundle.shoot.status === 'edited') throw new Error(`${bundle.shoot.code} is live: its recipes are built from the edited clips, so nothing on it can change.`)
}

/** Formats on the plan: added by hand, plus every format the shoot's VOs use. */
function planFormats(bundle: LoadedShoot) {
  const formats = new Map(bundle.plannedFormats.map(format => [format.id, { id: format.id, code: format.code, name: format.name, kind: format.kind, beats: format.beats, beat_display: format.beat_display, beat_broll: format.beat_broll, planned: true }]))
  for (const group of groupShotList(bundle.items).filter(entry => entry.kind === 'body')) {
    const format = group.items[0]!.format
    if (!format?.id || formats.has(format.id)) continue
    formats.set(format.id, { id: format.id, code: format.code, name: format.name ?? format.code, kind: format.kind ?? 'modular', beats: format.beats, beat_display: format.beat_display ?? null, beat_broll: format.beat_broll, planned: false })
  }
  return [...formats.values()].sort((a, b) => a.code.localeCompare(b.code))
}

const findGroup = (bundle: LoadedShoot, code: string): ShotGroup => {
  const group = groupShotList(bundle.items).find(entry => same(entry.code, code))
  if (!group) throw new Error(`There's no ${code.toUpperCase()} on ${bundle.shoot.code}'s shot list (get_shoot lists it).`)
  return group
}

/** Beats in the format's order, matched by name; every beat needs a script. */
function orderedBeats(formatBeats: string[], given: { beat: string, script: string, alternates?: string[], hook_type?: string }[], formatCode: string): Beat[] {
  const byBeat = new Map(given.map(entry => [entry.beat.trim().toLowerCase(), entry]))
  const missing = formatBeats.filter(name => !byBeat.get(name.toLowerCase())?.script.trim())
  if (missing.length) throw new Error(`${formatCode} needs these beats too: ${missing.join(', ')}. Its beats are, in order: ${formatBeats.join(', ')}.`)
  return formatBeats.map((name) => {
    const entry = byBeat.get(name.toLowerCase())!
    const alternates = (entry.alternates ?? []).map(script => script.trim()).filter(Boolean).map(script => ({ script }))
    return { beat: name, script: entry.script.trim(), ...(entry.hook_type ? { hook_type: entry.hook_type } : {}), ...(alternates.length ? { alternates } : {}) }
  })
}

const beatInput = z.object({
  beat: z.string().min(1).max(60).describe('The beat\'s name, exactly as the format lists it'),
  script: z.string().min(1).max(1000).describe('What\'s said in this beat, with slots'),
  alternates: z.array(z.string().min(1).max(1000)).max(5).optional().describe('Other wordings of this beat, each filmed as its own take and mixed into extra versions (best on the first and last beats)'),
  hook_type: z.string().max(80).optional().describe('A standalone format\'s hook beat: its hook type')
})
type BeatInput = z.infer<typeof beatInput>

const wordingsArg = z.array(z.string().min(1).max(1000)).max(5).optional()
  .describe('Other wordings of the line, each filmed as its own take (H01-2, H01-3…) and mixed into extra versions up to the shoot’s wording mixes')

export function registerShootTools(kit: ShootToolKit) {
  const { server, guarded, text, failure, link, paths, pace, organisationArg } = kit
  const shootArg = z.string().min(2).max(10).describe('The shoot code, e.g. S008')

  // --- reading ------------------------------------------------------------------------------------
  server.registerTool('get_shoot', {
    title: 'Get shoot',
    description: 'Everything about one shoot: its setup, people, channels and custom slots, its formats, every hook, VO and CTA on its shot list (with scripts as they\'ll be filmed, locations and per-person wording), its b-roll shot list, and, for a draft, what still stops it being planned.',
    inputSchema: z.object({ code: shootArg, organisation: organisationArg }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ code }: { code: string, organisation?: string }, _org, db) => {
    const bundle = await loadShoot(db, code)
    const { shoot } = bundle
    const personName = (id: string | null) => bundle.people.find(person => person.id === id)?.name ?? null
    const channelName = (id: string | null) => bundle.channels.find(channel => channel.id === id)?.name ?? null
    const formats = planFormats(bundle)
    return text({
      code: shoot.code,
      link: link(paths.shoot(shoot.code)),
      status: shoot.status,
      stale: !!shoot.stale_at,
      date: shoot.shoot_date,
      brand: bundle.brand.name,
      product: { id: bundle.product.id, name: bundle.product.name, claims_allowed: bundle.product.claims_allowed, claims_forbidden: bundle.product.claims_forbidden },
      setup: {
        kit: shoot.kit,
        batch_size_pct: Math.round(Number(shoot.submission_rate) * 1000) / 10,
        target_per_channel: shoot.runway_target,
        broll_variations: shoot.broll_variations,
        cast_mixes: shoot.vo_variations,
        wording_mixes: shoot.wording_variations,
        location_notes: shoot.location_notes,
        notes: shoot.notes
      },
      custom_slots: parseSlotValues(shoot.slot_values),
      people: bundle.people.map(person => person.name),
      channels: bundle.channels.map(channel => ({
        name: channel.name,
        slot_values: parseSlotValues(channel.slot_values),
        filmed_by: (bundle.channelPeople?.[channel.id] ?? []).map(personName).filter(Boolean)
      })),
      formats: formats.map(format => ({ code: format.code, name: format.name, kind: format.kind, beats: format.beats, added_by_hand: format.planned })),
      shot_list: groupShotList(bundle.items).map((group) => {
        const first = group.items[0]!
        const script = resolveItemScript(bundle, { ...first, script_override: null })
        const overrides = group.items.filter(item => item.script_override !== null && item.script_override !== undefined).map((item) => {
          const own = resolveItemScript(bundle, item)
          return { person: personName(item.person_id), channel: channelName(item.channel_id), script: own.beats ? own.beats.map(beat => ({ beat: beat.beat, script: beat.script })) : own.text }
        })
        return {
          code: group.code,
          kind: group.kind === 'body' ? 'vo' : group.kind,
          id: group.template_id,
          ...(group.kind === 'body' ? { link: link(paths.vo(shoot.code, group.template_id)) } : {}),
          about: first.title ?? null,
          hook_type: first.hook_type,
          format: first.format?.code ?? null,
          cta_mode: first.cta_mode,
          written_here: first.home === 'shoot',
          location: first.location,
          script: script.beats ? script.beats.map(beat => ({ beat: beat.beat, script: beat.script })) : script.text,
          // a hook or CTA's other wordings, each filmed as its own take (H01-2…)
          other_wordings: script.alternates.length ? script.alternates : undefined,
          unfilled_slots: script.unfilled.length ? script.unfilled : undefined,
          people: [...new Set(group.items.map(item => personName(item.person_id)).filter(Boolean))],
          filmed: group.items.filter(item => item.status === 'filmed').length || undefined,
          per_person_wording: overrides.length ? overrides : undefined
        }
      }),
      broll: bundle.broll.map((shot) => {
        const format = formats.find(entry => entry.id === shot.format_id)
        return {
          id: shot.id,
          section: format?.code ?? 'general',
          beat: shot.beat,
          description: shot.description,
          feature: shot.feature?.name ?? null,
          channel: channelName(shot.channel_id),
          status: shot.status
        }
      }),
      can_plan: shoot.status === 'draft' ? planBlockers(bundle).length === 0 : undefined,
      to_plan: shoot.status === 'draft' ? planBlockers(bundle) : undefined
    })
  }))

  // --- setup ----------------------------------------------------------------------------------------
  server.registerTool('update_shoot', {
    title: 'Update shoot',
    description: 'Change a shoot\'s setup: product, date, people, channels, formats, custom slot values, batch size, target per channel, b-roll variations, cast and wording mixes, kit, location notes and notes. Only what you pass changes. While it\'s a draft everything can change; once planned, only batch size, target, kit and notes. Taking people, channels or formats off takes their lines (and a format\'s VOs and b-roll) off the shot list.',
    inputSchema: z.object({
      shoot: shootArg,
      product_id: z.string().uuid().optional().describe('Another product (from list_brands). Only while it has no VOs.'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Shoot date, YYYY-MM-DD (null clears)'),
      people: z.array(z.string().max(120)).max(50).optional().describe('Everyone filming it, by name, replacing the list. Each films the shot list on the shoot\'s channels they\'re linked to.'),
      channels: z.array(z.string().max(120)).max(50).optional().describe('Its channels, by name, replacing the list'),
      add_formats: z.array(z.string().max(20)).max(20).optional().describe('Format codes to add, e.g. ["F03"]'),
      remove_formats: z.array(z.string().max(20)).max(20).optional().describe('Format codes to take off (their VOs and b-roll go too)'),
      custom_slots: z.record(z.string().max(60), z.string().max(500).nullable()).optional().describe('Custom slot values for this shoot, e.g. {"benefit": "calmer walks"}; null removes one. Built-in and channel slots fill themselves.'),
      batch_size_pct: z.number().min(0).max(100).optional().describe('The share of the shoot\'s valid recipes each batch submits, %'),
      target_per_channel: z.number().int().min(1).max(10_000).optional().describe('Submissions per channel per month'),
      broll_variations: z.number().int().min(1).max(10).optional(),
      cast_mixes: z.number().int().min(0).max(50).optional().describe('Mixes of cast members\' beats per VO per channel (0 = none)'),
      wording_mixes: z.number().int().min(0).max(50).optional().describe('Extra combinations of alternate beat wordings per person (0 = first wordings only)'),
      kit: z.enum(['audition', 'scale', 'custom']).optional(),
      location_notes: z.string().max(2000).nullable().optional(),
      notes: z.string().max(4000).nullable().optional(),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, guarded(async (input: {
    shoot: string, product_id?: string, date?: string | null, people?: string[], channels?: string[], add_formats?: string[], remove_formats?: string[],
    custom_slots?: Record<string, string | null>, batch_size_pct?: number, target_per_channel?: number, broll_variations?: number,
    cast_mixes?: number, wording_mixes?: number, kit?: string, location_notes?: string | null, notes?: string | null, organisation?: string
  }, org, db) => {
    let bundle = await loadShoot(db, input.shoot)
    requireNotLive(bundle)
    const changed: string[] = []
    const draftOnly = (['product_id', 'date', 'people', 'channels', 'add_formats', 'remove_formats', 'custom_slots', 'broll_variations', 'cast_mixes', 'wording_mixes'] as const)
      .filter(key => input[key] !== undefined)
    if (draftOnly.length) requireDraft(bundle, `its ${draftOnly.join(', ').replaceAll('_', ' ')}`)

    const patch: Update<'shoots'> = {}
    if (input.product_id !== undefined && input.product_id !== bundle.shoot.product_id) {
      if (groupShotList(bundle.items).some(group => group.kind === 'body')) throw new Error('It has VOs written for its product: take them off first to change the product.')
      const product = check(await db.from('products').select('id, brand:brands(archived_at)').eq('id', input.product_id).maybeSingle())
      if (!product) throw new Error('That product isn\'t in this organisation. Use an id from list_brands.')
      if ((product.brand as { archived_at: string | null } | null)?.archived_at) throw new Error('That product\'s brand is archived.')
      patch.product_id = input.product_id
    }
    if (input.date !== undefined) patch.shoot_date = input.date
    if (input.batch_size_pct !== undefined) patch.submission_rate = input.batch_size_pct / 100
    if (input.target_per_channel !== undefined) patch.runway_target = input.target_per_channel
    if (input.broll_variations !== undefined) patch.broll_variations = input.broll_variations
    if (input.cast_mixes !== undefined) patch.vo_variations = input.cast_mixes
    if (input.wording_mixes !== undefined) patch.wording_variations = input.wording_mixes
    if (input.kit !== undefined) patch.kit = input.kit
    if (input.location_notes !== undefined) patch.location_notes = input.location_notes?.trim() || null
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null
    if (input.custom_slots) {
      const values = { ...parseSlotValues(bundle.shoot.slot_values) } as Record<string, string>
      for (const [name, value] of Object.entries(input.custom_slots)) {
        const key = name.replace(/^\{\{|\}\}$/g, '').trim()
        if (value === null || !value.trim()) delete values[key]
        else values[key] = value.trim()
      }
      patch.slot_values = values as Json
    }
    if (Object.keys(patch).length) {
      check(await db.from('shoots').update(patch).eq('id', bundle.shoot.id))
      changed.push(...Object.keys(patch))
    }

    let reload = Object.keys(patch).length > 0
    if (input.people) {
      const everyone = list(await db.from('people').select('id, name, active'))
      const picked = byNames(everyone, input.people, 'person')
      if (reload) bundle = await loadShoot(db, bundle.shoot.code)
      await setShootPeople(db, bundle, picked.map(person => person.id))
      changed.push('people')
      reload = true
    }
    if (input.channels) {
      const all = list(await db.from('channels').select('id, name'))
      const picked = byNames(all, input.channels, 'channel')
      if (reload) bundle = await loadShoot(db, bundle.shoot.code)
      await setShootChannels(db, bundle, picked.map(channel => channel.id))
      changed.push('channels')
      reload = true
    }
    if (input.people || input.channels) {
      bundle = await loadShoot(db, bundle.shoot.code)
      await fillMissingItems(db, bundle)
    }
    if (input.add_formats?.length || input.remove_formats?.length) {
      const codes = [...(input.add_formats ?? []), ...(input.remove_formats ?? [])].map(entry => entry.trim().toUpperCase())
      const rows = list(await db.from('formats').select('id, code, archived').in('code', codes))
      const unknown = codes.filter(entry => !rows.some(row => row.code === entry))
      if (unknown.length) throw new Error(`These aren't formats here: ${unknown.join(', ')}.`)
      bundle = await loadShoot(db, bundle.shoot.code)
      const onPlan = new Set(bundle.plannedFormats.map(format => format.id))
      const adding = rows.filter(row => input.add_formats?.some(entry => same(entry, row.code)) && !onPlan.has(row.id))
      const archived = adding.filter(row => row.archived)
      if (archived.length) throw new Error(`${archived.map(row => row.code).join(', ')} ${archived.length === 1 ? 'is' : 'are'} archived.`)
      if (adding.length) check(await db.from('shoot_formats').insert(adding.map(row => ({ shoot_id: bundle.shoot.id, format_id: row.id }))))
      for (const row of rows.filter(entry => input.remove_formats?.some(code => same(code, entry.code)))) {
        await removeFormat(db, bundle, row.id)
        bundle = await loadShoot(db, bundle.shoot.code)
      }
      changed.push('formats')
    }
    if (!changed.length) return failure('Nothing to change: pass at least one field.')
    bundle = await loadShoot(db, bundle.shoot.code)
    return text({
      updated: bundle.shoot.code,
      organisation: org.name,
      changed: [...new Set(changed)],
      people: bundle.people.map(person => person.name),
      channels: bundle.channels.map(channel => channel.name),
      formats: planFormats(bundle).map(format => format.code),
      shot_list_lines: bundle.items.length,
      to_plan: bundle.shoot.status === 'draft' ? planBlockers(bundle) : undefined,
      link: link(paths.shoot(bundle.shoot.code))
    })
  }))

  // --- the shot list ----------------------------------------------------------------------------------
  server.registerTool('add_to_shot_list', {
    title: 'Add to shot list',
    description: 'Put hooks, VOs and CTAs on a draft shoot\'s shot list, for everyone filming it: Library ones by id (get_library, search_library), earlier VOs for this product by id, and/or new hooks and CTAs written just for this shoot (they stay out of the Library unless kept for the product with edit_shot_list). A VO linked to particular hooks or CTAs brings them too. Each gets a code (H01, V01, C01).',
    inputSchema: z.object({
      shoot: shootArg,
      hook_ids: z.array(z.string().uuid()).max(50).optional().describe('Library hooks (general, or for this product)'),
      vo_ids: z.array(z.string().uuid()).max(50).optional().describe('VOs for this product (from this shoot or earlier ones)'),
      cta_ids: z.array(z.string().uuid()).max(50).optional().describe('Library CTAs (general, or for this product)'),
      new_hooks: z.array(z.object({
        script: z.string().min(1).max(500),
        caption: z.string().max(500).optional().describe('A suggested post caption'),
        filming_notes: z.string().max(1000).optional().describe('How to film it'),
        hook_type: z.string().max(80).optional().describe('A hook type name from get_workspace'),
        other_wordings: wordingsArg
      })).max(20).optional().describe('Hooks written just for this shoot'),
      new_ctas: z.array(z.object({ script: z.string().min(1).max(500), mode: z.enum(['sync', 'vo']).describe('sync: said on camera; vo: voiceover over footage'), other_wordings: wordingsArg })).max(20).optional()
        .describe('CTAs written just for this shoot'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: {
    shoot: string, hook_ids?: string[], vo_ids?: string[], cta_ids?: string[],
    new_hooks?: { script: string, caption?: string, filming_notes?: string, hook_type?: string, other_wordings?: string[] }[], new_ctas?: { script: string, mode: 'sync' | 'vo', other_wordings?: string[] }[], organisation?: string
  }, org, db) => {
    const bundle = await loadShoot(db, input.shoot)
    requireDraft(bundle, 'its shot list')
    if (!bundle.people.length) return failure(`Add people to ${bundle.shoot.code} first (update_shoot people): everyone on it films the shot list.`)
    const productId = bundle.shoot.product_id
    const fits = (row: { product_id: string | null, shoot_id: string | null }) => (row.product_id === null || row.product_id === productId) && (row.shoot_id === null || row.shoot_id === bundle.shoot.id)
    const hooks: Row<'hook_templates'>[] = input.hook_ids?.length ? list(await db.from('hook_templates').select('*').in('id', input.hook_ids)) : []
    const ctas: Row<'cta_templates'>[] = input.cta_ids?.length ? list(await db.from('cta_templates').select('*').in('id', input.cta_ids)) : []
    const vos: Row<'body_templates'>[] = input.vo_ids?.length ? list(await db.from('body_templates').select('*').in('id', input.vo_ids)) : []
    const missing = [
      ...(input.hook_ids ?? []).filter(id => !hooks.some(row => row.id === id && fits(row))).map(id => `hook ${id}`),
      ...(input.cta_ids ?? []).filter(id => !ctas.some(row => row.id === id && fits(row))).map(id => `CTA ${id}`),
      ...(input.vo_ids ?? []).filter(id => !vos.some(row => row.id === id && row.product_id === productId)).map(id => `VO ${id}`)
    ]
    if (missing.length) return failure(`These aren't for ${bundle.product.name} (or don't exist): ${missing.join(', ')}.`)

    const wps = await pace(db)
    if (input.new_hooks?.length) {
      const types = list(await db.from('angles').select('id, name').eq('archived', false))
      hooks.push(...list(await db.from('hook_templates').insert(input.new_hooks.map(hook => ({
        script: hook.script.trim(),
        caption: hook.caption?.trim() || null,
        filming_notes: hook.filming_notes?.trim() || null,
        angle_id: hook.hook_type ? types.find(type => same(type.name, hook.hook_type!))?.id ?? null : null,
        est_seconds: estimateSeconds(hook.script, wps) || null,
        shoot_id: bundle.shoot.id
      }))).select('*')))
    }
    if (input.new_ctas?.length) {
      ctas.push(...list(await db.from('cta_templates').insert(input.new_ctas.map(cta => ({
        script: cta.script.trim(),
        mode: cta.mode,
        est_seconds: estimateSeconds(cta.script, wps) || null,
        shoot_id: bundle.shoot.id
      }))).select('*')))
    }
    if (!hooks.length && !ctas.length && !vos.length) return failure('Nothing to add: pass ids or new hooks / CTAs.')
    const added = await addToShotList(db, bundle, { hooks, bodies: vos, ctas })
    let after = await loadShoot(db, bundle.shoot.code)
    // new hooks' and CTAs' other wordings, by their line
    const wordings = [
      ...(input.new_hooks ?? []).map(hook => ({ kind: 'hook', script: hook.script.trim(), others: hook.other_wordings ?? [] })),
      ...(input.new_ctas ?? []).map(cta => ({ kind: 'cta', script: cta.script.trim(), others: cta.other_wordings ?? [] }))
    ].filter(entry => entry.others.length)
    for (const entry of wordings) {
      const template = [...hooks, ...ctas].find(row => row.script === entry.script && row.shoot_id === bundle.shoot.id)
      const group = groupShotList(after.items).find(other => other.kind === entry.kind && other.template_id === template?.id)
      if (group) await setAlternates(db, after, group, entry.others)
    }
    if (wordings.length) after = await loadShoot(db, bundle.shoot.code)
    return text({
      added: added.map(entry => ({ code: entry.code, kind: entry.kind === 'body' ? 'vo' : entry.kind })),
      already_on: hooks.length + ctas.length + vos.length > added.length ? 'Some were already on the shot list.' : undefined,
      organisation: org.name,
      shoot: after.shoot.code,
      to_plan: planBlockers(after),
      link: link(paths.shoot(after.shoot.code))
    })
  }))

  server.registerTool('edit_shot_list', {
    title: 'Edit shot list',
    description: 'Change entries on a shoot\'s shot list, by code (H01, V02, C01): where it\'s filmed, its wording for everyone on this shoot, one person\'s own wording, and, for a hook or CTA, its other wordings on a draft (each filmed as its own take, H01-2…, and mixed into extra versions up to the shoot\'s wording mixes), its wording in the Library for good, or keeping one written here for the product\'s later shoots. A VO\'s own wording, channel and alternates change with update_vo.',
    inputSchema: z.object({
      shoot: shootArg,
      entries: z.array(z.object({
        code: z.string().min(2).max(10),
        location: z.string().max(200).nullable().optional().describe('Where it\'s filmed (null clears)'),
        script: z.string().min(1).max(1000).optional().describe('Hooks and CTAs: the line for everyone on this shoot only'),
        other_wordings: wordingsArg.describe('Hooks and CTAs on a draft: every other wording of the line, replacing the ones it has ([] removes them)'),
        beats: z.array(z.object({ beat: z.string().max(60), script: z.string().min(1).max(1000) })).max(20).optional().describe('VOs: every beat\'s line for everyone on this shoot only'),
        library_script: z.string().min(1).max(1000).optional().describe('Hooks and CTAs: change the line in the Library itself (every shoot that uses it later)'),
        keep_for_product: z.boolean().optional().describe('A hook or CTA written here: keep it in the Library for this product\'s later shoots'),
        person_wording: z.array(z.object({
          person: z.string().max(120),
          channel: z.string().max(120).optional().describe('Only on this channel (default all of theirs)'),
          script: z.string().max(1000).nullable().optional().describe('Hooks and CTAs: their own line (null goes back to everyone\'s)'),
          beats: z.array(z.object({ beat: z.string().max(60), script: z.string().min(1).max(1000) })).max(20).nullable().optional().describe('VOs: their own beats (null goes back to everyone\'s)')
        })).max(20).optional()
      })).min(1).max(50),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot: code, entries }: {
    shoot: string
    entries: { code: string, location?: string | null, script?: string, other_wordings?: string[], beats?: { beat: string, script: string }[], library_script?: string, keep_for_product?: boolean,
      person_wording?: { person: string, channel?: string, script?: string | null, beats?: { beat: string, script: string }[] | null }[] }[]
    organisation?: string
  }, org, db) => {
    const bundle = await loadShoot(db, code)
    requireNotLive(bundle)
    const draft = bundle.shoot.status === 'draft'
    const done: string[] = []
    const ids = (group: ShotGroup) => group.items.map(item => item.id)
    const beatsFor = (group: ShotGroup, given: { beat: string, script: string }[]) => {
      const names = group.items[0]!.format?.beats ?? given.map(entry => entry.beat)
      return orderedBeats(names, given, group.items[0]!.format?.code ?? 'This VO').map(beat => ({ beat: beat.beat, script: beat.script }))
    }
    for (const entry of entries) {
      const group = findGroup(bundle, entry.code)
      const isVo = group.kind === 'body'
      const table = group.kind === 'hook' ? 'hook_templates' as const : 'cta_templates' as const
      if (entry.location !== undefined) {
        check(await db.from('shoot_items').update({ location: entry.location?.trim() || null }).in('id', ids(group)))
        done.push(`${group.code}: location`)
      }
      if (entry.script !== undefined || entry.beats !== undefined || entry.person_wording?.length) requireDraft(bundle, `${group.code}'s wording`)
      if (entry.script !== undefined) {
        if (isVo) throw new Error(`${group.code} is a VO: give its beats instead of a script.`)
        check(await db.from('shoot_items').update({ script_snapshot: entry.script.trim() }).in('id', ids(group)))
        done.push(`${group.code}: wording for everyone`)
      }
      if (entry.other_wordings !== undefined) {
        if (isVo) throw new Error(`${group.code} is a VO: its beats' other wordings change with update_vo.`)
        requireDraft(bundle, `${group.code}'s wordings`)
        const fresh = await loadShoot(db, bundle.shoot.code)
        const set = await setAlternates(db, fresh, findGroup(fresh, group.code), entry.other_wordings)
        done.push(`${group.code}: ${set.length ? `${set.length + 1} wordings` : 'one wording'}`)
      }
      if (entry.beats !== undefined) {
        if (!isVo) throw new Error(`${group.code} is a ${KIND_WORDS[group.kind]}: give a script instead of beats.`)
        check(await db.from('shoot_items').update({ script_snapshot: beatsFor(group, entry.beats) as unknown as Json }).in('id', ids(group)))
        done.push(`${group.code}: wording for everyone`)
      }
      if (entry.library_script !== undefined) {
        if (isVo) throw new Error(`${group.code} is a VO: change it with update_vo.`)
        const script = entry.library_script.trim()
        check(await db.from(table).update({ script }).eq('id', group.template_id))
        // this shoot follows: a draft keeps the slots, a planned shoot's copy is frozen with them filled
        if (draft) check(await db.from('shoot_items').update({ script_snapshot: script }).in('id', ids(group)))
        else for (const item of group.items) check(await db.from('shoot_items').update({ script_snapshot: renderScript(script, itemSlotContext(bundle, item.channel_id)).text }).eq('id', item.id))
        done.push(`${group.code}: Library wording`)
      }
      if (entry.keep_for_product) {
        if (isVo) throw new Error(`${group.code} is a VO: VOs are always kept for the product.`)
        if (group.items[0]!.home !== 'shoot') throw new Error(`${group.code} isn't one written on this shoot: it's already in the Library.`)
        const current = group.items[0]!.script_snapshot
        check(await db.from(table).update({ shoot_id: null, product_id: bundle.shoot.product_id, ...(draft && typeof current === 'string' ? { script: current } : {}) }).eq('id', group.template_id))
        done.push(`${group.code}: kept for ${bundle.product.name}`)
      }
      for (const wording of entry.person_wording ?? []) {
        const [person] = byNames(bundle.people, [wording.person], `person on ${bundle.shoot.code}`)
        const channel = wording.channel ? byNames(bundle.channels, [wording.channel], `channel on ${bundle.shoot.code}`)[0] : null
        const items = group.items.filter(item => item.person_id === person!.id && (!channel || item.channel_id === channel.id))
        if (!items.length) throw new Error(`${person!.name} doesn't film ${group.code}${channel ? ` on ${channel.name}` : ''}.`)
        const value = isVo
          ? (wording.beats === null ? null : wording.beats ? beatsFor(group, wording.beats) : undefined)
          : (wording.script === null ? null : wording.script?.trim())
        if (value === undefined) throw new Error(`Give ${person!.name}'s ${isVo ? 'beats' : 'script'} for ${group.code}, or null to go back to everyone's.`)
        check(await db.from('shoot_items').update({ script_override: value as unknown as Json }).in('id', items.map(item => item.id)))
        done.push(`${group.code}: ${person!.name}'s wording ${value === null ? 'cleared' : 'set'}`)
      }
    }
    if (!done.length) return failure('Nothing to change: give each entry something to change.')
    return text({ changed: done, organisation: org.name, shoot: bundle.shoot.code, link: link(paths.shoot(bundle.shoot.code)) })
  }))

  server.registerTool('remove_from_shot_list', {
    title: 'Remove from shot list',
    description: 'Take hooks, VOs or CTAs off a draft shoot\'s shot list, by code, for everyone filming them (with any per-person wording). One written on this shoot that no other shoot uses is deleted; Library ones stay in the Library. Confirm with the person first.',
    inputSchema: z.object({ shoot: shootArg, codes: z.array(z.string().min(2).max(10)).min(1).max(100), organisation: organisationArg }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, guarded(async ({ shoot: code, codes }: { shoot: string, codes: string[], organisation?: string }, org, db) => {
    const bundle = await loadShoot(db, code)
    requireDraft(bundle, 'its shot list')
    const groups = codes.map(entry => findGroup(bundle, entry))
    await removeFromShotList(db, bundle, groups)
    return text({ removed: groups.map(group => group.code), organisation: org.name, shoot: bundle.shoot.code, link: link(paths.shoot(bundle.shoot.code)) })
  }))

  // --- VOs ------------------------------------------------------------------------------------------
  server.registerTool('update_vo', {
    title: 'Update VO',
    description: 'Change a VO on a shoot: its beats (with alternate wordings), title, feature, notes, source link and channel (one its writer is on: everyone on the shoot who is on it reads the VO, there only; with none, everyone on each of the writer\'s channels reads it there), and put it on the shot list. Only its writer or the team can. A VO on the shot list of a draft keeps its lines in step.',
    inputSchema: z.object({
      shoot: shootArg,
      vo: z.string().min(2).max(60).describe('The VO\'s code on the shot list (e.g. V02) or its id (from add_vo)'),
      beats: z.array(beatInput).min(1).max(20).optional().describe('Every beat of its format, in order'),
      title: z.string().max(120).nullable().optional(),
      feature: z.string().max(120).nullable().optional().describe('The product feature it\'s about, by name (null: the product as a whole)'),
      channel: z.string().max(120).nullable().optional().describe('The channel it\'s for, by name: one its writer is on, and everyone on it reads it (null: each of the writer\'s channels)'),
      notes: z.string().max(4000).nullable().optional(),
      source_url: z.string().url().max(500).nullable().optional().describe('A reference video'),
      on_plan: z.boolean().optional().describe('true: put it on the shot list (a draft VO from add_vo isn\'t on it yet)'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: {
    shoot: string, vo: string, beats?: BeatInput[], title?: string | null, feature?: string | null, channel?: string | null,
    notes?: string | null, source_url?: string | null, on_plan?: boolean, organisation?: string
  }, org, db) => {
    let bundle = await loadShoot(db, input.shoot)
    requireNotLive(bundle)
    const byCode = groupShotList(bundle.items).find(group => group.kind === 'body' && same(group.code, input.vo))
    const voId = byCode?.template_id ?? input.vo.trim()
    if (!/^[0-9a-f-]{36}$/i.test(voId)) return failure(`There's no VO ${input.vo} on ${bundle.shoot.code}'s shot list.`)
    const vo = check(await db.from('body_templates').select('*, format:formats(code, beats)').eq('id', voId).maybeSingle())
    if (!vo || vo.product_id !== bundle.shoot.product_id) return failure(`That VO isn't for ${bundle.product.name}.`)
    const onList = groupShotList(bundle.items).some(group => group.template_id === vo.id)
    if (onList || input.on_plan) requireDraft(bundle, 'its VOs')

    const patch: Update<'body_templates'> = {}
    if (input.beats) {
      const format = vo.format as { code: string, beats: string[] } | null
      const beats = orderedBeats(format?.beats ?? input.beats.map(beat => beat.beat), input.beats, format?.code ?? 'Its format')
      patch.beats = beats as unknown as Json
      patch.est_seconds = estimateSeconds(beats.map(beat => beat.script).join(' '), await pace(db)) || null
    }
    if (input.title !== undefined) patch.title = input.title?.trim() || null
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null
    if (input.source_url !== undefined) patch.source_url = input.source_url
    if (input.feature !== undefined) {
      if (input.feature === null) patch.feature_id = null
      else {
        const feature = check(await db.from('product_features').select('id').eq('product_id', vo.product_id).ilike('name', input.feature.trim()).maybeSingle())
        if (!feature) return failure(`${bundle.product.name} has no feature called "${input.feature}" (list_brands shows its features).`)
        patch.feature_id = feature.id
      }
    }
    // its channel: one its writer is on; everyone on it reads the VO
    if (input.channel !== undefined) {
      if (input.channel === null) patch.cast_channel_id = null
      else {
        const channelId = byNames(bundle.channels, [input.channel], `channel on ${bundle.shoot.code}`)[0]!.id
        if (!vo.person_id || !(bundle.channelPeople?.[channelId] ?? []).includes(vo.person_id)) {
          return failure(`Its writer isn't on ${input.channel}: pick one of their channels.`)
        }
        patch.cast_channel_id = channelId
      }
    }
    const saved = (Object.keys(patch).length
      ? check(await db.from('body_templates').update(patch).eq('id', vo.id).select('*').single())
      : check(await db.from('body_templates').select('*').eq('id', vo.id).single()))!
    let code = groupShotList(bundle.items).find(group => group.template_id === vo.id)?.code ?? null
    if (onList || input.on_plan) {
      const added = await syncVoOnPlan(db, bundle, saved)
      code = code ?? added[0]?.code ?? null
      bundle = await loadShoot(db, bundle.shoot.code)
    }
    return text({
      updated: 'VO',
      organisation: org.name,
      shoot: bundle.shoot.code,
      code,
      on_shot_list: !!code,
      changed: Object.keys(patch),
      link: link(paths.vo(bundle.shoot.code, vo.id))
    })
  }))

  // --- b-roll -------------------------------------------------------------------------------------------
  /** A b-roll section: a format on the plan (its b-roll beats), or the general product shots. */
  function sectionOf(bundle: LoadedShoot, section: string) {
    if (same(section, 'general')) return { formatId: null as string | null, code: 'general', beats: null as string[] | null, suggestions: null as Record<string, { description: string }[]> | null }
    const format = planFormats(bundle).find(entry => same(entry.code, section))
    if (!format) throw new Error(`${section.toUpperCase()} isn't on ${bundle.shoot.code}'s plan. Sections are its formats (${planFormats(bundle).map(entry => entry.code).join(', ') || 'none yet'}) and "general".`)
    return {
      formatId: format.id,
      code: format.code,
      beats: format.beats.filter(beat => beatShow(format, beat) === 'broll'),
      suggestions: parseBeatSuggestions(format.beat_broll)
    }
  }

  server.registerTool('add_broll', {
    title: 'Add b-roll',
    description: 'Add b-roll shots to a shoot\'s b-roll list (shared by every channel): in a format\'s section, under one of its beats that\'s shown over b-roll, or in "general" (product shots any VO can use, beat "product"). A shot can be for one product feature: it then only goes under VOs about it. Or add the team\'s suggested shots for a section or beat.',
    inputSchema: z.object({
      shoot: shootArg,
      shots: z.array(z.object({
        section: z.string().max(20).describe('A format code on the plan, or "general"'),
        beat: z.string().max(60).optional().describe('The beat it goes under (general: "product", the default)'),
        description: z.string().min(1).max(500).describe('What to film'),
        feature: z.string().max(120).optional().describe('The product feature it shows, by name (draft only)')
      })).max(50).optional(),
      suggested: z.array(z.object({
        section: z.string().max(20).describe('A format code on the plan, or "general"'),
        beat: z.string().max(60).optional().describe('Only this beat\'s suggestions (default every beat)')
      })).max(20).optional().describe('Add the suggested shots written on the format (or in Settings for general) that aren\'t on the list yet'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot: code, shots, suggested }: {
    shoot: string, shots?: { section: string, beat?: string, description: string, feature?: string }[], suggested?: { section: string, beat?: string }[], organisation?: string
  }, org, db) => {
    const bundle = await loadShoot(db, code)
    requireNotLive(bundle)
    if (!shots?.length && !suggested?.length) return failure('Nothing to add: pass shots or suggested.')
    const features = list(await db.from('product_features').select('id, name').eq('product_id', bundle.shoot.product_id))
    let order = Math.max(0, ...bundle.broll.map(shot => shot.sort_order))
    const rows: { shoot_id: string, channel_id: null, format_id: string | null, beat: string, description: string, feature_id: string | null, sort_order: number }[] = []
    const has = (formatId: string | null, beat: string, description: string) =>
      [...bundle.broll, ...rows].some(shot => shot.format_id === formatId && shot.beat === beat && same(shot.description, description))
    const beatIn = (section: ReturnType<typeof sectionOf>, beat: string | undefined) => {
      if (!section.beats) return beat?.trim() || 'product'
      const name = section.beats.find(entry => same(entry, beat ?? ''))
      if (!name) throw new Error(`${section.code}'s beats shown over b-roll are ${section.beats.join(', ') || 'none'}${beat ? `, not "${beat}"` : ': say which'}.`)
      return name
    }
    for (const shot of shots ?? []) {
      const section = sectionOf(bundle, shot.section)
      const beat = beatIn(section, shot.beat)
      let featureId: string | null = null
      if (shot.feature) {
        requireDraft(bundle, 'a b-roll shot\'s feature')
        featureId = byNames(features, [shot.feature], `feature of ${bundle.product.name}`)[0]!.id
      }
      rows.push({ shoot_id: bundle.shoot.id, channel_id: null, format_id: section.formatId, beat, description: shot.description.trim(), feature_id: featureId, sort_order: ++order })
    }
    let general: { description: string }[] | null = null
    for (const ask of suggested ?? []) {
      const section = sectionOf(bundle, ask.section)
      let lists: [string, { description: string }[]][]
      if (section.suggestions) {
        const beats = ask.beat ? [beatIn(section, ask.beat)] : section.beats!
        lists = beats.map(beat => [beat, section.suggestions![beat] ?? []])
      } else {
        general ??= parseSuggestions(check(await db.from('settings').select('general_broll').limit(1).maybeSingle())?.general_broll)
        lists = [['product', general]]
      }
      for (const [beat, list] of lists) {
        for (const suggestion of list) {
          if (!has(section.formatId, beat, suggestion.description)) rows.push({ shoot_id: bundle.shoot.id, channel_id: null, format_id: section.formatId, beat, description: suggestion.description, feature_id: null, sort_order: ++order })
        }
      }
    }
    if (!rows.length) return failure('Nothing new to add: those suggestions are already on the list (or there are none; they\'re written on the format\'s beats in Library → Formats, and in Settings → Defaults for general).')
    const added = list(await db.from('broll_shots').insert(rows).select('id, format_id, beat, description'))
    const codeOf = (formatId: string | null) => planFormats(bundle).find(format => format.id === formatId)?.code ?? 'general'
    return text({
      added: added.map(shot => ({ id: shot.id, section: codeOf(shot.format_id), beat: shot.beat, description: shot.description })),
      organisation: org.name,
      shoot: bundle.shoot.code,
      link: link(`${paths.shoot(bundle.shoot.code)}?tab=broll`)
    })
  }))

  server.registerTool('update_broll', {
    title: 'Update b-roll',
    description: 'Change b-roll shots on a shoot, by id (get_shoot lists them): what to film, the beat it goes under, or (while it\'s a draft) the product feature it\'s for.',
    inputSchema: z.object({
      shoot: shootArg,
      shots: z.array(z.object({
        id: z.string().uuid(),
        description: z.string().min(1).max(500).optional(),
        beat: z.string().max(60).optional(),
        feature: z.string().max(120).nullable().optional().describe('The feature it shows, by name; null: generic')
      })).min(1).max(50),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot: code, shots }: { shoot: string, shots: { id: string, description?: string, beat?: string, feature?: string | null }[], organisation?: string }, org, db) => {
    const bundle = await loadShoot(db, code)
    requireNotLive(bundle)
    const features = list(await db.from('product_features').select('id, name').eq('product_id', bundle.shoot.product_id))
    const formats = planFormats(bundle)
    const changed: string[] = []
    for (const change of shots) {
      const shot = bundle.broll.find(entry => entry.id === change.id)
      if (!shot) throw new Error(`There's no b-roll shot ${change.id} on ${bundle.shoot.code}.`)
      const patch: Update<'broll_shots'> = {}
      if (change.description !== undefined) patch.description = change.description.trim()
      if (change.beat !== undefined) {
        const format = formats.find(entry => entry.id === shot.format_id)
        const section = sectionOf(bundle, format?.code ?? 'general')
        patch.beat = section.beats ? section.beats.find(beat => same(beat, change.beat!)) ?? (() => { throw new Error(`${section.code}'s b-roll beats are ${section.beats!.join(', ')}.`) })() : change.beat.trim()
      }
      if (change.feature !== undefined) {
        requireDraft(bundle, 'a b-roll shot\'s feature')
        patch.feature_id = change.feature === null ? null : byNames(features, [change.feature], `feature of ${bundle.product.name}`)[0]!.id
      }
      if (!Object.keys(patch).length) continue
      check(await db.from('broll_shots').update(patch).eq('id', shot.id))
      changed.push(shot.id)
    }
    if (!changed.length) return failure('Nothing to change.')
    return text({ updated: changed.length, organisation: org.name, shoot: bundle.shoot.code, link: link(`${paths.shoot(bundle.shoot.code)}?tab=broll`) })
  }))

  server.registerTool('remove_broll', {
    title: 'Remove b-roll',
    description: 'Take b-roll shots off a draft shoot\'s list, by id (get_shoot lists them), or every shot in a section. Confirm with the person first.',
    inputSchema: z.object({
      shoot: shootArg,
      ids: z.array(z.string().uuid()).max(200).optional(),
      section: z.string().max(20).optional().describe('Every shot in this section: a format code, "general", or "all"'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, guarded(async ({ shoot: code, ids, section }: { shoot: string, ids?: string[], section?: string, organisation?: string }, org, db) => {
    const bundle = await loadShoot(db, code)
    requireDraft(bundle, 'its b-roll list')
    let targets = bundle.broll.filter(shot => ids?.includes(shot.id))
    const unknown = (ids ?? []).filter(id => !bundle.broll.some(shot => shot.id === id))
    if (unknown.length) return failure(`These aren't b-roll shots on ${bundle.shoot.code}: ${unknown.join(', ')}.`)
    if (section) {
      const formatIds = planFormats(bundle).map(format => format.id)
      const inSection = same(section, 'all')
        ? bundle.broll
        : same(section, 'general')
          ? bundle.broll.filter(shot => !shot.format_id || !formatIds.includes(shot.format_id))
          : bundle.broll.filter(shot => shot.format_id === sectionOf(bundle, section).formatId)
      targets = [...new Map([...targets, ...inSection].map(shot => [shot.id, shot])).values()]
    }
    if (!targets.length) return failure('Nothing to remove.')
    for (let i = 0; i < targets.length; i += 200) check(await db.from('broll_shots').delete().in('id', targets.slice(i, i + 200).map(shot => shot.id)))
    return text({ removed: targets.length, organisation: org.name, shoot: bundle.shoot.code, link: link(`${paths.shoot(bundle.shoot.code)}?tab=broll`) })
  }))

  // --- status ---------------------------------------------------------------------------------------
  server.registerTool('set_shoot_status', {
    title: 'Set shoot status',
    description: 'Move a shoot along (the team only): "planned" freezes a ready draft\'s scripts (get_shoot\'s to_plan must be empty); "draft" takes a planned shoot (not yet started) back to editing; "shooting" starts filming a planned shoot, or resumes a filmed one; "filmed" ends filming (Dropbox must be connected: the clips then upload from each phone); "stale" archives a shoot from the shoots list, "not_stale" brings it back. Uploads, editing, going Live and making batches happen in Kreate and Klip. Confirm with the person first, and before ending say how many shots are still to film (get_shoot).',
    inputSchema: z.object({ shoot: shootArg, status: z.enum(['planned', 'draft', 'shooting', 'filmed', 'stale', 'not_stale']), organisation: organisationArg }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot: code, status }: { shoot: string, status: 'planned' | 'draft' | 'shooting' | 'filmed' | 'stale' | 'not_stale', organisation?: string }, org, db) => {
    if (!isTeamRole(org.role)) return failure('Only the team can change a shoot\'s status.')
    const bundle = await loadShoot(db, code)
    const { shoot } = bundle
    if (status === 'planned') {
      if (shoot.status !== 'draft') return failure(`${shoot.code} is ${STATUS_WORDS[shoot.status] ?? shoot.status}, not a draft.`)
      await planShoot(db, bundle)
    } else if (status === 'draft') {
      if (shoot.status !== 'planned') return failure(`Only a planned shoot that hasn't started goes back to draft; ${shoot.code} is ${STATUS_WORDS[shoot.status] ?? shoot.status}.`)
      check(await db.from('shoots').update({ status: 'draft' }).eq('id', shoot.id).eq('status', 'planned'))
    } else if (status === 'shooting') {
      if (shoot.status !== 'planned' && shoot.status !== 'filmed') return failure(`Only a planned shoot starts filming, or a filmed one resumes; ${shoot.code} is ${STATUS_WORDS[shoot.status] ?? shoot.status}.`)
      check(await db.from('shoots').update({ status: 'shooting' }).eq('id', shoot.id).eq('status', shoot.status))
    } else if (status === 'filmed') {
      if (shoot.status !== 'shooting') return failure(`Only a shoot being filmed can end; ${shoot.code} is ${STATUS_WORDS[shoot.status] ?? shoot.status}.`)
      check(await db.from('shoots').update({ status: 'filmed' }).eq('id', shoot.id).eq('status', 'shooting'))
    } else {
      const { data: claims } = await db.auth.getClaims()
      const stale = status === 'stale'
      check(await db.from('shoots').update({ stale_at: stale ? new Date().toISOString() : null, stale_by: stale ? claims?.claims.sub ?? null : null }).eq('id', shoot.id))
    }
    return text({
      shoot: shoot.code,
      organisation: org.name,
      now: status,
      ...(status === 'planned' ? { next: 'Its exports are ready in Kreate. Open the shoot and use Export → Create folders in Dropbox if its Dropbox folders aren\'t made yet.' } : {}),
      ...(status === 'shooting' || status === 'filmed' ? { still_to_film: [...bundle.items, ...bundle.broll].filter(entry => entry.status === 'planned').length } : {}),
      ...(status === 'filmed' ? { next: 'Clips upload to Dropbox from each phone. Then the team sends it for editing in Kreate.' } : {}),
      link: link(paths.shoot(shoot.code))
    })
  }))
}
