import * as z from 'zod/v4'
import type { Update } from '#shared/types/models'
import type { Manifest } from '#shared/utils/manifest'
import type { ShootToolKit } from './connectorShootTools'

// The AI connector's account tools: the Settings an AI needs to write well (voice, channel slots,
// script rules, planning defaults), hook types, treatments, channels and who's on them, and a Live
// shoot's batch scores. Each writes what the matching page writes, under the same database rules
// (most are the team's only). Team, roles, invites, billing, partnerships and the Dropbox and Klip
// connections stay with people in Kreate.

export interface AccountToolKit extends Omit<ShootToolKit, 'paths'> {
  paths: { shoot: (code: string) => string }
}

const check = <T>(result: { data: T, error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const slotName = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
const teamOnly = (role: string, what: string) => {
  if (!isTeamRole(role)) throw new Error(`Only the team can change ${what}.`)
}

export function registerAccountTools(kit: AccountToolKit) {
  const { server, guarded, text, failure, link, paths, organisationArg } = kit
  const settingsLink = (tab: string) => link(`/settings?tab=${tab}`)

  async function settingsRow(db: ConnectorDb) {
    const row = check(await db.from('settings').select('*').limit(1).maybeSingle())
    if (!row) throw new Error('This organisation has no settings yet.')
    return row
  }

  // --- voice, slots, rules, defaults ------------------------------------------------------------
  server.registerTool('update_workspace', {
    title: 'Update workspace',
    description: 'Change the organisation\'s Settings (the team only): its profile and voice (what get_workspace gives you to write by), its channel slots, its script rules (words to avoid), speech pace, planning defaults and general product shots. Only what you pass changes; lists you pass replace what\'s there, so start from get_workspace. Confirm with the person before replacing or removing slots or rules.',
    inputSchema: z.object({
      profile: z.object({
        about: z.string().max(1000).optional().describe('What the organisation is'),
        products: z.string().max(1000).optional().describe('What its ads sell'),
        creators: z.string().max(1000).optional().describe('Who films them'),
        audience: z.string().max(1000).optional().describe('Who they\'re for'),
        voice: z.string().max(1000).optional().describe('How scripts should sound'),
        language: z.string().max(80).optional().describe('Spelling to write in, e.g. British English')
      }).optional().describe('Profile fields to change ("" clears one)'),
      voice: z.string().max(4000).nullable().optional().describe('The whole preamble AI apps are given, in the organisation\'s own words; null goes back to the one Kreate writes from the profile'),
      channel_slots: z.array(z.object({
        name: z.string().min(1).max(40).describe('The slot, used as {{name}}'),
        description: z.string().max(300).optional(),
        example: z.string().max(200).optional()
      })).max(30).optional().describe('Every channel slot, replacing the current ones. Each channel fills its own value (update_channel).'),
      script_rules: z.array(z.object({
        phrases: z.array(z.string().min(1).max(80)).min(1).max(30).describe('Words or phrases to flag (plurals are caught too)'),
        message: z.string().min(1).max(300).describe('The warning shown when one is used'),
        suggestion: z.string().max(300).optional().describe('What to say instead')
      })).max(100).optional().describe('Every script rule, replacing the current ones'),
      words_per_second: z.number().min(0.5).max(6).optional().describe('Speech pace, for estimating lengths'),
      default_batch_size_pct: z.number().min(0.5).max(100).optional().describe('New shoots\' batch size, % of recipes'),
      minutes_per_hook: z.number().min(0).max(120).optional(),
      minutes_per_vo: z.number().min(0).max(240).optional(),
      minutes_per_cta_sync: z.number().min(0).max(120).optional().describe('Minutes to film an on-camera CTA'),
      minutes_per_cta_vo: z.number().min(0).max(120).optional().describe('Minutes to record a voiceover CTA'),
      productive_hours_per_day: z.number().min(0.5).max(24).optional(),
      general_broll: z.array(z.string().min(1).max(300)).max(50).optional().describe('General product shots suggested on every shoot, replacing the current ones'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, guarded(async (input: {
    profile?: Partial<Record<'about' | 'products' | 'creators' | 'audience' | 'voice' | 'language', string>>, voice?: string | null,
    channel_slots?: { name: string, description?: string, example?: string }[], script_rules?: { phrases: string[], message: string, suggestion?: string }[],
    words_per_second?: number, default_batch_size_pct?: number, minutes_per_hook?: number, minutes_per_vo?: number, minutes_per_cta_sync?: number,
    minutes_per_cta_vo?: number, productive_hours_per_day?: number, general_broll?: string[], organisation?: string
  }, org, db) => {
    teamOnly(org.role, 'Settings')
    const row = await settingsRow(db)
    const fields: Record<string, unknown> = {}
    if (input.profile) fields.org_profile = { ...parseOrgProfile(row.org_profile), ...Object.fromEntries(Object.entries(input.profile).map(([key, value]) => [key, (value ?? '').trim()])) }
    if (input.voice !== undefined) fields.ai_preamble = input.voice?.trim() || null
    if (input.channel_slots) {
      const slots = input.channel_slots.map(slot => ({ name: slotName(slot.name), description: (slot.description ?? '').trim(), example: (slot.example ?? '').trim() }))
      for (const [index, slot] of slots.entries()) {
        if (!slot.name) return failure(`Channel slot "${input.channel_slots[index]!.name}" needs a name made of letters, numbers or _.`)
        if ((BUILT_IN_SLOTS as readonly string[]).includes(slot.name)) return failure(`{{${slot.name}}} is built in: it can't be a channel slot.`)
        if (slots.findIndex(other => other.name === slot.name) !== index) return failure(`{{${slot.name}}} is in the list twice.`)
      }
      fields.channel_slots = slots
    }
    if (input.script_rules) fields.script_rules = parseScriptRules(input.script_rules)
    for (const key of ['words_per_second', 'minutes_per_hook', 'minutes_per_vo', 'minutes_per_cta_sync', 'minutes_per_cta_vo', 'productive_hours_per_day'] as const) {
      if (input[key] !== undefined) fields[key] = input[key]
    }
    if (input.default_batch_size_pct !== undefined) fields.default_submission_rate = Math.round(input.default_batch_size_pct * 10) / 1000
    if (input.general_broll) fields.general_broll = parseSuggestions(input.general_broll.map(description => ({ description })))
    if (!Object.keys(fields).length) return failure('Nothing to change: pass what should change.')
    check(await db.from('settings').update(fields as Update<'settings'>).eq('id', row.id))
    const after = await settingsRow(db)
    return text({
      updated: 'settings',
      organisation: org.name,
      changed: Object.keys(fields),
      voice: aiPreamble(org.name, after),
      voice_is_own: !!after.ai_preamble?.trim(),
      link: settingsLink('scripts')
    })
  }))

  // --- hook types ----------------------------------------------------------------------------------
  server.registerTool('add_hook_types', {
    title: 'Add hook types',
    description: 'Add hook types (the kind of opening a hook uses: Confession, Curiosity, Newness…) to the Library. Check get_workspace\'s hook_types first so they aren\'t duplicates.',
    inputSchema: z.object({
      hook_types: z.array(z.object({ name: z.string().min(1).max(80), description: z.string().max(1000).optional() })).min(1).max(20),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ hook_types }: { hook_types: { name: string, description?: string }[], organisation?: string }, org, db) => {
    const existing = check(await db.from('angles').select('name')) ?? []
    const fresh = hook_types.filter((type, index) => !existing.some(row => same(row.name, type.name)) && hook_types.findIndex(other => same(other.name, type.name)) === index)
    if (fresh.length) check(await db.from('angles').insert(fresh.map(type => ({ name: type.name.trim(), description: type.description?.trim() || null }))))
    return text({ added: fresh.length, skipped_already_there: hook_types.length - fresh.length, organisation: org.name, link: link('/library?tab=types') })
  }))

  server.registerTool('update_hook_type', {
    title: 'Update hook type',
    description: 'Rename a hook type, change its description, or archive or restore it (archived ones aren\'t offered for new hooks; hooks that have it keep it). Confirm with the person before archiving.',
    inputSchema: z.object({
      name: z.string().min(1).max(80).describe('Its current name'),
      new_name: z.string().min(1).max(80).optional(),
      description: z.string().max(1000).nullable().optional(),
      archived: z.boolean().optional(),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ name, new_name, description, archived }: { name: string, new_name?: string, description?: string | null, archived?: boolean, organisation?: string }, org, db) => {
    const rows = check(await db.from('angles').select('id, name')) ?? []
    const row = rows.find(entry => same(entry.name, name))
    if (!row) return failure(`There's no hook type "${name}". There's ${rows.map(entry => entry.name).join(', ') || 'none'}.`)
    const fields: Record<string, unknown> = {}
    if (new_name?.trim()) {
      if (rows.some(entry => entry.id !== row.id && same(entry.name, new_name))) return failure(`There's already a hook type called ${new_name}.`)
      fields.name = new_name.trim()
    }
    if (description !== undefined) fields.description = description?.trim() || null
    if (archived !== undefined) fields.archived = archived
    if (!Object.keys(fields).length) return failure('Nothing to change: pass what should change.')
    check(await db.from('angles').update(fields as Update<'angles'>).eq('id', row.id))
    return text({ updated: 'hook type', organisation: org.name, name: (fields.name as string) ?? row.name, changed: Object.keys(fields), link: link('/library?tab=types') })
  }))

  // --- treatments ----------------------------------------------------------------------------------
  server.registerTool('list_treatments', {
    title: 'List treatments',
    description: 'The treatments: ways a finished recipe is presented (layouts, overlays such as a search bar, footage such as greenscreen), and combinations of them. Every account has the same set, changed by Kreate only. Each one makes its own version of every recipe that has what it needs, unless a shoot switches it off (update_shoot treatments_off, until the shoot goes to editing).',
    inputSchema: z.object({ organisation: organisationArg }),
    annotations: { readOnlyHint: true }
  }, guarded(async (_input: { organisation?: string }, org, db) => {
    const rows = (check(await db.from('treatments').select('id, name, description, kind, placement, needs, component, settings, parts, active, system, sort_order')
      .eq('archived', false).eq('active', true).order('sort_order')) ?? [])
    const nameOf = (id: string) => rows.find(row => row.id === id)?.name ?? 'a removed treatment'
    return text({
      organisation: org.name,
      components: Object.keys(COMPONENT_INGREDIENTS),
      treatments: rows.map(({ id: _id, parts, sort_order: _order, ...row }) => ({
        ...row,
        ...(parts.length ? { combination_of: parts.map(nameOf) } : {}),
        drawable: row.component === 'combo' ? parts.length > 0 && parts.every(part => (rows.find(entry => entry.id === part)?.component ?? '') in COMPONENT_INGREDIENTS) : row.component in COMPONENT_INGREDIENTS
      })),
      link: link('/library?tab=treatments')
    })
  }))

  // --- channels -------------------------------------------------------------------------------------
  /** The people who can be on channels: members (by name), and pending invites (by name or email). */
  async function castOptions(db: ConnectorDb) {
    const [people, invites] = await Promise.all([
      db.from('people').select('id, name, user_id').eq('active', true).not('user_id', 'is', null),
      db.from('org_invites').select('email, display_name, channel_ids')
    ])
    return { people: check(people) ?? [], invites: check(invites) ?? [] }
  }

  async function setMembers(db: ConnectorDb, channelId: string, names: string[]) {
    const { people, invites } = await castOptions(db)
    const users: string[] = []
    const invited: string[] = []
    const unknown: string[] = []
    for (const name of names) {
      const person = people.find(entry => same(entry.name, name))
      const invite = invites.find(entry => same(entry.email, name) || (!!entry.display_name && same(entry.display_name, name)))
      if (person) users.push(person.user_id!)
      else if (invite) invited.push(invite.email)
      else unknown.push(name)
    }
    if (unknown.length) throw new Error(`Not in the account: ${unknown.join(', ')}. People: ${[...people.map(entry => entry.name), ...invites.map(entry => `${entry.display_name || entry.email} (invited)`)].join(', ') || 'none'}. New people are invited in Kreate (Settings → Team).`)
    check(await db.rpc('set_channel_members', { p_channel_id: channelId, p_user_ids: [...new Set(users)] }))
    for (const invite of invites) {
      const wanted = invited.includes(invite.email)
      if (wanted === invite.channel_ids.includes(channelId)) continue
      const ids = wanted ? [...invite.channel_ids, channelId] : invite.channel_ids.filter(id => id !== channelId)
      check(await db.from('org_invites').update({ channel_ids: ids }).eq('email', invite.email))
    }
  }

  async function channelSummary(db: ConnectorDb, id: string) {
    const [channel, links, invites] = await Promise.all([
      db.from('channels').select('id, name, slug, folder_slug, active, slot_values').eq('id', id).single(),
      db.from('person_channels').select('person:people(name)').eq('channel_id', id),
      db.from('org_invites').select('email, display_name, channel_ids').contains('channel_ids', [id])
    ])
    const row = check(channel)!
    return {
      name: row.name, folder: row.folder_slug, active: row.active, slot_values: parseSlotValues(row.slot_values),
      people: [
        ...(check(links) ?? []).map(entry => (entry.person as { name: string } | null)?.name).filter(Boolean),
        ...(check(invites) ?? []).map(entry => `${entry.display_name || entry.email} (invited)`)
      ],
      link: settingsLink('channels')
    }
  }

  const channelInputs = {
    slot_values: z.record(z.string(), z.string().max(300)).optional().describe('Values for the channel slots (get_workspace), by slot name; "" clears one. Merged onto what\'s there.'),
    people: z.array(z.string().max(200)).max(50).optional().describe('Who films for it, by name (or an invite\'s email), replacing who\'s on it now'),
    active: z.boolean().optional().describe('false: no longer used for new shoots')
  }
  type ChannelInput = { slot_values?: Record<string, string>, people?: string[], active?: boolean, organisation?: string }
  const cleanValues = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([name, value]) => [slotName(name), value.trim()]))

  server.registerTool('list_channels', {
    title: 'List channels',
    description: 'The organisation\'s channels (the social accounts videos go out on): each one\'s slot values, who films for it, and whether it\'s in use.',
    inputSchema: z.object({ organisation: organisationArg }),
    annotations: { readOnlyHint: true }
  }, guarded(async (_args: { organisation?: string }, org, db) => {
    const rows = check(await db.from('channels').select('id').order('name')) ?? []
    return text({ organisation: org.name, channels: await Promise.all(rows.map(row => channelSummary(db, row.id))) })
  }))

  server.registerTool('add_channel', {
    title: 'Add channel',
    description: 'Add a channel (the team only): a social account videos go out on, with its slot values and who films for it. New brands don\'t get it automatically: add it to brands with update_brand.',
    inputSchema: z.object({ name: z.string().min(1).max(120), ...channelInputs, organisation: organisationArg }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: ChannelInput & { name: string }, org, db) => {
    teamOnly(org.role, 'channels')
    const existing = check(await db.from('channels').select('name, slug')) ?? []
    if (existing.some(row => same(row.name, input.name))) return failure(`There's already a channel called ${input.name}.`)
    const base = slugify(input.name) || 'channel'
    let slug = base
    for (let n = 2; existing.some(row => row.slug === slug); n++) slug = `${base}-${n}`
    const row = check(await db.from('channels').insert({
      name: input.name.trim(), slug, folder_slug: slug, active: input.active ?? true,
      slot_values: Object.fromEntries(Object.entries(cleanValues(input.slot_values ?? {})).filter(([, value]) => value))
    }).select('id').single())!
    if (input.people) await setMembers(db, row.id, input.people)
    return text({ added: 'channel', organisation: org.name, ...await channelSummary(db, row.id) })
  }))

  server.registerTool('update_channel', {
    title: 'Update channel',
    description: 'Change a channel (the team only): rename it, fill or change its slot values, change who films for it, or stop using it. Its Dropbox folder name never changes. Shoots already planned keep what they were planned with.',
    inputSchema: z.object({ name: z.string().min(1).max(120).describe('Its current name'), new_name: z.string().min(1).max(120).optional(), ...channelInputs, organisation: organisationArg }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async (input: ChannelInput & { name: string, new_name?: string }, org, db) => {
    teamOnly(org.role, 'channels')
    const rows = check(await db.from('channels').select('id, name, slot_values')) ?? []
    const row = rows.find(entry => same(entry.name, input.name))
    if (!row) return failure(`There's no channel "${input.name}". There's ${rows.map(entry => entry.name).join(', ') || 'none'}.`)
    const fields: Record<string, unknown> = {}
    if (input.new_name?.trim()) {
      if (rows.some(entry => entry.id !== row.id && same(entry.name, input.new_name!))) return failure(`There's already a channel called ${input.new_name}.`)
      fields.name = input.new_name.trim()
    }
    if (input.active !== undefined) fields.active = input.active
    if (input.slot_values) {
      fields.slot_values = Object.fromEntries(Object.entries({ ...parseSlotValues(row.slot_values), ...cleanValues(input.slot_values) }).filter(([, value]) => value))
    }
    if (!Object.keys(fields).length && !input.people) return failure('Nothing to change: pass what should change.')
    if (Object.keys(fields).length) check(await db.from('channels').update(fields as Update<'channels'>).eq('id', row.id))
    if (input.people) await setMembers(db, row.id, input.people)
    return text({ updated: 'channel', organisation: org.name, changed: [...Object.keys(fields), ...(input.people ? ['people'] : [])], ...await channelSummary(db, row.id) })
  }))

  // --- batches: scores ---------------------------------------------------------------------------
  const shootArg = z.string().min(2).max(10).describe('The shoot code, e.g. S008')

  async function liveShoot(db: ConnectorDb, code: string) {
    const shoot = check(await db.from('shoots').select('id, code, status').eq('code', code.trim().toUpperCase()).maybeSingle())
    if (!shoot) throw new Error(`There's no shoot ${code}. Use a code from list_shoots.`)
    if (shoot.status !== 'edited') throw new Error(`${shoot.code} isn't Live, so it has no batches.`)
    const [manifest, batches, overrides] = await Promise.all([
      db.from('shoot_manifests').select('data').eq('shoot_id', shoot.id).order('version', { ascending: false }).limit(1).maybeSingle(),
      db.from('shoot_shortlists').select('id, code, size, entry_ids, status, status_at, created_at').eq('shoot_id', shoot.id).order('code'),
      db.from('shoot_element_overrides').select('element_kind, element_key, dropped').eq('shoot_id', shoot.id)
    ])
    const batchRows = check(batches) ?? []
    const scores = batchRows.length
      ? check(await db.from('batch_scores').select('shortlist_id, element_kind, element_key, score').in('shortlist_id', batchRows.map(batch => batch.id))) ?? []
      : []
    const data = check(manifest)?.data as Manifest | null | undefined
    const recipes = data ? buildRecipes(data) : []
    return { shoot, recipes, batches: batchRows, scores, overrides: check(overrides) ?? [] }
  }

  function batchReport(loaded: Awaited<ReturnType<typeof liveShoot>>) {
    const byId = new Map(loaded.recipes.map(recipe => [recipe.id, recipe]))
    const measured = new Set(loaded.batches.filter(batch => batch.status === 'measured').map(batch => batch.id))
    const records = elementRecords(loaded.scores.filter(row => measured.has(row.shortlist_id)), loaded.overrides)
    return {
      shoot: loaded.shoot.code,
      recipes: loaded.recipes.length,
      batches: loaded.batches.map((batch) => {
        const recipes = batch.entry_ids.map(id => byId.get(id)).filter(recipe => !!recipe)
        const scored = new Map(loaded.scores.filter(row => row.shortlist_id === batch.id).map(row => [`${row.element_kind}:${row.element_key}`, row.score]))
        return {
          code: batch.code,
          status: batch.status,
          since: batch.status_at,
          renders: batch.size,
          elements: batchElements(recipes).map(element => ({ ...element, score: scored.get(elementId(element)) ?? null }))
        }
      }),
      // tallies across measured batches; dropped ones aren't picked for new batches
      records: [...records.entries()].map(([id, record]) => ({ element: id, ...record, state: elementState(record) })),
      score_guide: SCORE_GUIDE,
      link: link(`${paths.shoot(loaded.shoot.code)}?tab=batches`)
    }
  }

  server.registerTool('get_batches', {
    title: 'Get batches',
    description: 'A Live shoot\'s batches: each one\'s status (batched, rendering, submitted, measured), renders, and the elements its recipes use (treatments, hooks, formats, hook types, VOs, CTAs, people) with their scores; plus each element\'s tally across measured batches, and the scoring guide. Making batches happens in Kreate.',
    inputSchema: z.object({ shoot: shootArg, organisation: organisationArg }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ shoot }: { shoot: string, organisation?: string }, org, db) => text({ organisation: org.name, ...batchReport(await liveShoot(db, shoot)) })))

  server.registerTool('score_batch', {
    title: 'Score batch',
    description: 'Score a batch\'s elements winner, mid or loser by the scoring guide (get_batches), or clear a score (null), and move the batch along (rendering, submitted, measured). Only measured batches count toward which elements the next batch picks or drops. Only score from results the person gives you; never guess.',
    inputSchema: z.object({
      shoot: shootArg,
      batch: z.string().min(2).max(10).describe('The batch code, e.g. B01'),
      scores: z.array(z.object({
        kind: z.enum(ELEMENT_KINDS),
        key: z.string().min(1).max(200).describe('The element\'s key, as get_batches shows it'),
        score: z.enum(SCORES).nullable()
      })).max(200).optional(),
      status: z.enum(['batched', 'rendering', 'submitted', 'measured']).optional(),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot, batch: code, scores, status }: { shoot: string, batch: string, scores?: { kind: string, key: string, score: string | null }[], status?: string, organisation?: string }, org, db) => {
    const loaded = await liveShoot(db, shoot)
    const batch = loaded.batches.find(entry => same(entry.code, code))
    if (!batch) return failure(`${loaded.shoot.code} has no batch ${code}. It has ${loaded.batches.map(entry => entry.code).join(', ') || 'none yet'}.`)
    const recipes = batch.entry_ids.map(id => loaded.recipes.find(recipe => recipe.id === id)).filter(recipe => !!recipe)
    const inBatch = new Set(batchElements(recipes).map(elementId))
    const notIn = (scores ?? []).filter(entry => !inBatch.has(`${entry.kind}:${entry.key}`))
    if (notIn.length) return failure(`Not in ${batch.code}: ${notIn.map(entry => `${entry.kind} ${entry.key}`).join(', ')}. get_batches lists its elements.`)
    if (!scores?.length && !status) return failure('Nothing to change: pass scores or a status.')
    for (const entry of scores ?? []) {
      if (entry.score) {
        check(await db.from('batch_scores').upsert({ shortlist_id: batch.id, element_kind: entry.kind, element_key: entry.key, score: entry.score, updated_at: new Date().toISOString() }))
      } else {
        check(await db.from('batch_scores').delete().eq('shortlist_id', batch.id).eq('element_kind', entry.kind).eq('element_key', entry.key))
      }
    }
    if (status && status !== batch.status) check(await db.from('shoot_shortlists').update({ status, status_at: new Date().toISOString() }).eq('id', batch.id))
    return text({ organisation: org.name, batch: batch.code, scored: scores?.length ?? 0, ...(status ? { status } : {}), ...batchReport(await liveShoot(db, shoot)) })
  }))

  server.registerTool('set_element_dropped', {
    title: 'Drop or keep element',
    description: 'Drop an element from a Live shoot\'s future batches by hand, keep one the automatic rule dropped (2+ losers and no wins), or go back to the rule (null). Confirm with the person first.',
    inputSchema: z.object({
      shoot: shootArg,
      kind: z.enum(ELEMENT_KINDS),
      key: z.string().min(1).max(200),
      dropped: z.boolean().nullable().describe('true drops it, false keeps it, null goes back to the automatic rule'),
      organisation: organisationArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async ({ shoot, kind, key, dropped }: { shoot: string, kind: string, key: string, dropped: boolean | null, organisation?: string }, org, db) => {
    const loaded = await liveShoot(db, shoot)
    if (!batchElements(loaded.recipes).some(element => element.kind === kind && element.key === key)) return failure(`${loaded.shoot.code}'s recipes have no ${kind} ${key}.`)
    if (dropped === null) check(await db.from('shoot_element_overrides').delete().eq('shoot_id', loaded.shoot.id).eq('element_kind', kind).eq('element_key', key))
    else check(await db.from('shoot_element_overrides').upsert({ shoot_id: loaded.shoot.id, element_kind: kind, element_key: key, dropped }))
    return text({ organisation: org.name, shoot: loaded.shoot.code, element: `${kind}:${key}`, now: dropped === null ? 'automatic' : dropped ? 'dropped' : 'kept', link: link(`${paths.shoot(loaded.shoot.code)}?tab=batches`) })
  }))
}
