// Changing a draft shoot's plan: who films, on which channels, and what's on the shot list.
// Shared by the shoot page and the AI connector, always with the caller's own Supabase client
// (so RLS and the database's guards apply). Each function writes, and callers reload the shoot.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../types/database.types'
import type { Insert, Row } from '../types/models'
import type { LoadedShoot } from './loadShoot'
import type { ShotGroup } from './shootsheet'
import { channelsFor, groupShotList, isStandalone, itemPrefix, nextItemCodes, performs, planSnapshots, unfilledItems } from './shootsheet'

type Db = SupabaseClient<Database>

function check<T>(result: { data: T, error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
/** A list query's rows (never null). */
const list = <T>(result: { data: T[] | null, error: { message: string } | null }): T[] => check(result) ?? []

const BATCH = 200
async function deleteIds(db: Db, table: 'shoot_items' | 'broll_shots', ids: string[]) {
  for (let i = 0; i < ids.length; i += BATCH) check(await db.from(table).delete().in('id', ids.slice(i, i + BATCH)))
}

export const groupsOfKind = (bundle: LoadedShoot, kind: 'hook' | 'body' | 'cta') =>
  groupShotList(bundle.items).filter(group => group.kind === kind)

/** A person's item for one channel, copying a shot-list entry (someone joins, or a channel is added). */
export function copyFor(shootId: string, group: ShotGroup, personId: string, channelId: string): Insert<'shoot_items'> {
  const source = group.items[0]!
  return {
    shoot_id: shootId,
    person_id: personId,
    kind: source.kind,
    hook_template_id: source.kind === 'hook' ? source.template_id : null,
    body_template_id: source.kind === 'body' ? source.template_id : null,
    cta_template_id: source.kind === 'cta' ? source.template_id : null,
    code: group.code,
    channel_id: channelId,
    cta_mode: source.cta_mode,
    location: source.location,
    script_snapshot: source.script_snapshot as Json,
    caption: source.caption ?? null,
    sort_order: source.sort_order
  }
}

/**
 * Make sure everyone on a draft shoot has an item for every shot-list entry on every one of the
 * shoot's channels they're linked to, a VO only where they read it (performs), and no VO line
 * where they don't. Runs after people or channels change, and when a draft opens. The links are
 * read fresh. Returns how many items it added or took off.
 */
export async function fillMissingItems(db: Db, bundle: LoadedShoot): Promise<number> {
  const groups = groupShotList(bundle.items)
  const personIds = bundle.people.map(person => person.id)
  const channelIds = bundle.channels.map(channel => channel.id)
  if (bundle.shoot.status !== 'draft' || !groups.length || !personIds.length || !channelIds.length) return 0
  const links = list(await db.from('person_channels').select('person_id, channel_id').in('person_id', personIds).in('channel_id', channelIds))
  const channelPeople: Record<string, string[]> = {}
  for (const link of links) channelPeople[link.channel_id] = [...(channelPeople[link.channel_id] ?? []), link.person_id]
  const have = new Set(bundle.items.map(item => `${item.template_id}|${item.person_id}|${item.channel_id}`))
  const rows = groups.flatMap(group => links
    .filter(link => performs(group.items[0]!, link.person_id, link.channel_id, channelPeople))
    .filter(link => !have.has(`${group.template_id}|${link.person_id}|${link.channel_id}`))
    .map(link => copyFor(bundle.shoot.id, group, link.person_id, link.channel_id)))
  if (rows.length) check(await db.from('shoot_items').insert(rows))
  // VO lines for people who no longer read it there (its channel changed, or who's on it)
  const gone = groups.filter(group => group.kind === 'body').flatMap(group => group.items)
    .filter(item => !performs(item, item.person_id, item.channel_id, channelPeople))
  if (gone.length) await deleteIds(db, 'shoot_items', gone.map(item => item.id))
  return rows.length + gone.length
}

/** Who's on the shoot: people taken off lose their items (cascade). Returns who was added and removed. */
export async function setShootPeople(db: Db, bundle: LoadedShoot, next: string[]) {
  const current = bundle.people.map(person => person.id)
  const added = next.filter(id => !current.includes(id))
  const removed = current.filter(id => !next.includes(id))
  if (added.length) check(await db.from('shoot_people').insert(added.map(person_id => ({ shoot_id: bundle.shoot.id, person_id }))))
  if (removed.length) check(await db.from('shoot_people').delete().eq('shoot_id', bundle.shoot.id).in('person_id', removed))
  return { added, removed }
}

/** The shoot's channels: a channel taken off takes its items and channel b-roll with it. */
export async function setShootChannels(db: Db, bundle: LoadedShoot, next: string[]) {
  const current = bundle.channels.map(channel => channel.id)
  const added = next.filter(id => !current.includes(id))
  const removed = current.filter(id => !next.includes(id))
  const shootId = bundle.shoot.id
  if (added.length) check(await db.from('shoot_channels').insert(added.map(channel_id => ({ shoot_id: shootId, channel_id }))))
  if (removed.length) {
    check(await db.from('broll_shots').delete().eq('shoot_id', shootId).in('channel_id', removed))
    check(await db.from('shoot_items').delete().eq('shoot_id', shootId).in('channel_id', removed))
    check(await db.from('shoot_channels').delete().eq('shoot_id', shootId).in('channel_id', removed))
  }
  return { added, removed }
}

export interface PickedItems {
  hooks: Row<'hook_templates'>[]
  bodies: Row<'body_templates'>[]
  ctas: Row<'cta_templates'>[]
}

/**
 * Put hooks, VOs and CTAs on the shot list: one entry each with its own code, and an item per
 * person per channel they film (a VO: everyone on its channel, or on each of its writer's). A VO
 * linked to hooks / CTAs only goes with those, so they come on with it. Ones already on are
 * skipped. Returns the entries added (kind and code).
 */
export async function addToShotList(db: Db, bundle: LoadedShoot, input: PickedItems): Promise<{ kind: string, code: string, template_id: string }[]> {
  if (!bundle.people.length) throw new Error('Add people to the shoot first: everyone on it films the shot list.')
  const groups = groupShotList(bundle.items)
  const existing = groups.map(group => group.template_id)
  let picked = input
  if (picked.bodies.length) {
    const voIds = picked.bodies.map(body => body.id)
    const have = new Set([...existing, ...picked.hooks.map(hook => hook.id), ...picked.ctas.map(cta => cta.id)])
    const hookIds = list(await db.from('vo_hook_links').select('hook_template_id').in('body_template_id', voIds))
      .map(link => link.hook_template_id).filter(id => !have.has(id))
    const ctaIds = list(await db.from('vo_cta_links').select('cta_template_id').in('body_template_id', voIds))
      .map(link => link.cta_template_id).filter(id => !have.has(id))
    if (hookIds.length) picked = { ...picked, hooks: [...picked.hooks, ...list(await db.from('hook_templates').select('*').in('id', [...new Set(hookIds)]))] }
    if (ctaIds.length) picked = { ...picked, ctas: [...picked.ctas, ...list(await db.from('cta_templates').select('*').in('id', [...new Set(ctaIds)]))] }
  }
  const codes = groups.map(group => group.code)
  let order = Math.max(0, ...bundle.items.map(item => item.sort_order))
  const take = (prefix: string) => {
    const next = nextItemCodes(codes, prefix, 1)[0]!
    codes.push(next)
    return next
  }

  const entries: (Omit<Insert<'shoot_items'>, 'shoot_id' | 'person_id'> & { template_id: string, performs?: (personId: string, channelId: string) => boolean })[] = []
  const seen = new Set(existing)
  const fresh = <T extends { id: string }>(rows: T[]) => rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  for (const hook of fresh(picked.hooks)) {
    entries.push({ template_id: hook.id, kind: 'hook', hook_template_id: hook.id, code: take(itemPrefix('hook')), script_snapshot: hook.script, caption: hook.caption, sort_order: ++order })
  }
  for (const body of fresh(picked.bodies)) {
    const vo = { kind: 'body' as const, writer_id: body.person_id, cast_channel_id: body.cast_channel_id }
    entries.push({
      template_id: body.id,
      kind: 'body', body_template_id: body.id, code: take('V'), script_snapshot: body.beats, sort_order: ++order,
      performs: (personId, channelId) => performs(vo, personId, channelId, bundle.channelPeople)
    })
  }
  for (const cta of fresh(picked.ctas)) {
    entries.push({ template_id: cta.id, kind: 'cta', cta_template_id: cta.id, code: take('C'), cta_mode: cta.mode, script_snapshot: cta.script, sort_order: ++order })
  }
  if (!entries.length) return []

  const rows = bundle.people.flatMap(person => entries
    .flatMap(({ performs: performsIt, template_id: _template, ...entry }) => channelsFor(bundle, person.id)
      .filter(channel => !performsIt || performsIt(person.id, channel.id))
      .map(channel => ({ ...entry, shoot_id: bundle.shoot.id, person_id: person.id, channel_id: channel.id }) as Insert<'shoot_items'>)))
  for (let i = 0; i < rows.length; i += BATCH) check(await db.from('shoot_items').insert(rows.slice(i, i + BATCH)))
  return entries.map(entry => ({ kind: entry.kind, code: entry.code, template_id: entry.template_id }))
}

const TEMPLATE_TABLES = {
  hook: { table: 'hook_templates', column: 'hook_template_id' },
  body: { table: 'body_templates', column: 'body_template_id' },
  cta: { table: 'cta_templates', column: 'cta_template_id' }
} as const

/**
 * Hooks, VOs and CTAs written in this shoot that no shoot uses any more are deleted with their
 * last line. One another shoot also uses stays; Library ones are never deleted. Only a VO's
 * writer or an admin can delete it, so for anyone else it stays with the product.
 */
export async function deleteUnusedTemplates(db: Db, shootId: string, kind: string, templateIds: string[]) {
  const target = TEMPLATE_TABLES[kind as keyof typeof TEMPLATE_TABLES]
  if (!target || !templateIds.length) return
  const used = new Set(list(await db.from('shoot_items').select(target.column).in(target.column, templateIds))
    .map(row => (row as Record<string, string | null>)[target.column]))
  const unused = templateIds.filter(id => !used.has(id))
  if (unused.length) check(await db.from(target.table).delete().in('id', unused).eq('shoot_id', shootId))
}

/** Take entries off the shot list for everyone (with per-person wording and ticks). */
export async function removeFromShotList(db: Db, bundle: LoadedShoot, groups: ShotGroup[]) {
  await deleteIds(db, 'shoot_items', groups.flatMap(group => group.items.map(item => item.id)))
  for (const kind of ['hook', 'body', 'cta']) {
    await deleteUnusedTemplates(db, bundle.shoot.id, kind, groups.filter(group => group.kind === kind).map(group => group.template_id))
  }
}

/** A format off the plan: its VOs come off the shot list and its b-roll section goes. */
export async function removeFormat(db: Db, bundle: LoadedShoot, formatId: string) {
  const vos = groupsOfKind(bundle, 'body').filter(group => group.items[0]?.format?.id === formatId)
  await removeFromShotList(db, bundle, vos)
  check(await db.from('broll_shots').delete().eq('shoot_id', bundle.shoot.id).eq('format_id', formatId))
  check(await db.from('shoot_formats').delete().eq('shoot_id', bundle.shoot.id).eq('format_id', formatId))
}

/**
 * After a VO on the shot list is saved: its lines take the new beats, and who reads it where
 * follows its channel (lines for anyone no longer reading it go, anyone new gets theirs). A VO
 * not on the shot list yet is put on it.
 */
export async function syncVoOnPlan(db: Db, bundle: LoadedShoot, vo: Row<'body_templates'>) {
  const group = groupsOfKind(bundle, 'body').find(entry => entry.template_id === vo.id)
  if (!group) return addToShotList(db, bundle, { hooks: [], bodies: [vo], ctas: [] })
  check(await db.from('shoot_items').update({ script_snapshot: vo.beats }).in('id', group.items.map(item => item.id)))
  const plays = { kind: 'body' as const, writer_id: vo.person_id, cast_channel_id: vo.cast_channel_id }
  const gone = group.items.filter(item => !performs(plays, item.person_id, item.channel_id, bundle.channelPeople))
  if (gone.length) await deleteIds(db, 'shoot_items', gone.map(item => item.id))
  const have = new Set(group.items.map(item => `${item.person_id}|${item.channel_id}`))
  const rows = bundle.people.map(person => person.id)
    .flatMap(personId => channelsFor(bundle, personId)
      .filter(channel => performs(plays, personId, channel.id, bundle.channelPeople) && !have.has(`${personId}|${channel.id}`))
      .map(channel => ({ ...copyFor(bundle.shoot.id, group, personId, channel.id), script_snapshot: vo.beats })))
  if (rows.length) check(await db.from('shoot_items').insert(rows))
  return []
}

/** What stops a draft being planned, in words a person can act on. */
export function planBlockers(bundle: LoadedShoot): string[] {
  const list: string[] = []
  const hooks = groupsOfKind(bundle, 'hook')
  const vos = groupsOfKind(bundle, 'body')
  const ctas = groupsOfKind(bundle, 'cta')
  if (!bundle.shoot.shoot_date) list.push('Set a shoot date')
  if (!bundle.people.length) list.push('Add at least one person')
  if (!bundle.channels.length) list.push('Add at least one channel')
  // hooks and CTAs only go with modular VOs: a shoot of standalone VOs alone needs neither
  const modular = vos.some(group => !isStandalone(group.items[0]!))
  if (modular && !hooks.length) list.push('Add hooks (Hooks): your modular VOs need them')
  if (!vos.length) list.push('Write VOs (VOs)')
  if (modular && !ctas.length) list.push('Add CTAs (CTAs): your modular VOs need them')
  const unlinked = bundle.people.filter(person => !channelsFor(bundle, person.id).length)
  const unfilmed = bundle.channels.filter(channel => !bundle.people.some(person => bundle.channelPeople?.[channel.id]?.includes(person.id)))
  if (unfilmed.length) {
    list.push(`Nobody on this shoot is linked to ${unfilmed.map(channel => channel.name).join(', ')}: add someone who is, or remove ${unfilmed.length === 1 ? 'it' : 'them'} (Settings → People)`)
  }
  if (unlinked.length) {
    list.push(`${unlinked.map(person => person.name).join(', ')} ${unlinked.length === 1 ? 'isn\'t' : 'aren\'t'} linked to any of this shoot's channels (Settings → People)`)
  }
  const unfilled = unfilledItems(bundle)
  if (unfilled.length) {
    list.push(`Fill or override the unfilled slots in ${unfilled.slice(0, 6).map(entry => entry.code).join(', ')}${unfilled.length > 6 ? '…' : ''}`)
  }
  return list
}

/** Mark a draft planned: the filled scripts are frozen into the snapshots so later template or product edits can't change it. */
export async function planShoot(db: Db, bundle: LoadedShoot) {
  const blockers = planBlockers(bundle)
  if (blockers.length) throw new Error(`It can't be planned yet: ${blockers.join('; ')}.`)
  const frozen = planSnapshots(bundle)
  for (let i = 0; i < frozen.length; i += 20) {
    const results = await Promise.all(frozen.slice(i, i + 20).map(entry =>
      db.from('shoot_items').update({
        script_snapshot: entry.script_snapshot as unknown as Json,
        script_override: entry.script_override as unknown as Json,
        caption: entry.caption
      }).eq('id', entry.id)
    ))
    results.forEach(check)
  }
  check(await db.from('shoots').update({ status: 'planned' }).eq('id', bundle.shoot.id))
}
