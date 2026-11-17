<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Row, Update } from '#shared/types/models'
import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { BundleItem, ShotGroup } from '#shared/utils/shootsheet'
import { brollChannelIds } from '#shared/utils/shootsheet'
import type { Beat } from '#shared/utils/slots'
import type { EditsCheck } from '#shared/utils/manifest'
import { wordingMixesAvailable } from '#shared/utils/recipes'
import type { PickedItems } from '~/components/planner/ItemPicker.vue'
import type { BrollFormat } from '~/components/planner/Broll.vue'

const route = useRoute()
const router = useRouter()
const db = useDb()
const run = useAction()
const { confirmDialog } = useConfirm()
const toast = useToast()
const { people: allPeople, channels: allChannels, productOptions, settings, load } = useRefData()
const code = route.params.code as string

const data = ref<LoadedShoot | null>(null)
async function refresh() {
  data.value = await loadShootBundle(db, code)
}
await Promise.all([load(), refresh()])
if (!data.value) throw createError({ statusCode: 404, statusMessage: `Shoot ${code} not found`, fatal: true })

const bundle = computed(() => data.value!)
const shoot = computed(() => bundle.value.shoot)
const isDraft = computed(() => shoot.value.status === 'draft')
// only admins move a shoot through its statuses (the database enforces it)
const { isAdmin } = useAccess()
/** Live (edited): the recipes are built, so the shoot's details lock and its batches take over */
const live = computed(() => shoot.value.status === 'edited')
const loop = useBatchLoop(bundle)
// every status change runs from the top bar (the next step) or Actions (moving back)
const controls = useTemplateRef<{ resume: () => Promise<void> }>('controls')
const editing = useTemplateRef<{
  startEditing: () => Promise<void>
  backToFilmed: () => Promise<void>
  check: () => Promise<void>
  goLive: (override?: boolean) => Promise<void>
  starting: boolean
  checking: boolean
  saving: boolean
  result: EditsCheck | null
}>('editing')
const channelIds = computed(() => bundle.value.channels.map(channel => channel.id))
const busy = ref(false)

// --- tabs ------------------------------------------------------------------
// General (setup, slots, what's left to do), Formats, then the video in order: Hooks, VOs
// (written here), CTAs, and B-roll. A Live shoot opens on Batches. The open tab lives in the URL
// so it survives reloads and can be linked.
const TAB_VALUES = ['batches', 'general', 'formats', 'hooks', 'vos', 'ctas', 'broll'] as const
type ShootTab = typeof TAB_VALUES[number]
const defaultTab = computed<ShootTab>(() => live.value ? 'batches' : 'general')
const tab = computed<ShootTab>({
  get: () => TAB_VALUES.includes(route.query.tab as ShootTab) && (live.value || route.query.tab !== 'batches') ? route.query.tab as ShootTab : defaultTab.value,
  set: value => router.replace({ query: { ...route.query, tab: value === defaultTab.value ? undefined : value } })
})
const tabItems = computed(() => [
  ...(live.value ? [{ label: 'Batches', value: 'batches', icon: 'i-lucide-layers', badge: loop.batches.value.length || undefined }] : []),
  { label: 'General', value: 'general', icon: 'i-lucide-settings-2' },
  { label: 'Formats', value: 'formats', icon: 'i-lucide-layout-template', badge: shootFormats.value.length || undefined },
  { label: 'Hooks', value: 'hooks', icon: 'i-lucide-anchor', badge: groupsOf('hook').length || undefined },
  { label: 'VOs', value: 'vos', icon: 'i-lucide-mic', badge: groupsOf('body').length || undefined },
  { label: 'CTAs', value: 'ctas', icon: 'i-lucide-megaphone', badge: groupsOf('cta').length || undefined },
  { label: 'B-roll', value: 'broll', icon: 'i-lucide-film', badge: bundle.value.broll.length || undefined }
].map(item => ({ ...item, badge: item.badge === undefined ? undefined : { label: String(item.badge), color: 'neutral' as const, variant: 'subtle' as const } })))

// --- setup -----------------------------------------------------------------
const form = reactive({
  product_id: '',
  shoot_date: '',
  submission_pct: 5,
  runway_target: 60,
  broll_variations: 1,
  vo_variations: 1,
  wording_variations: 1,
  kit: 'custom',
  location_notes: '',
  notes: ''
})
watch(shoot, (value) => {
  Object.assign(form, {
    product_id: value.product_id,
    shoot_date: value.shoot_date ?? '',
    submission_pct: Math.round(Number(value.submission_rate) * 1000) / 10,
    runway_target: value.runway_target,
    broll_variations: value.broll_variations,
    vo_variations: value.vo_variations,
    wording_variations: value.wording_variations,
    kit: value.kit,
    location_notes: value.location_notes ?? '',
    notes: value.notes ?? ''
  })
}, { immediate: true })


const kits = selectOptions(['audition', 'scale', 'custom'])

async function patchShoot(patch: Update<'shoots'>) {
  await run(async () => {
    must(await db.from('shoots').update(patch).eq('id', shoot.value.id))
    await refresh()
  })
}

// Wording mixes only shape the recipes, not what's filmed, so they can change until the first
// batch (once Live, in the Batches tab), up to the most any VO's wordings combine.
const wordingMax = computed(() => wordingMixesAvailable(bundle.value.items))
function saveWordings() {
  form.wording_variations = Math.min(wordingMax.value, Math.max(0, Math.round(Number(form.wording_variations) || 0)))
  if (form.wording_variations !== shoot.value.wording_variations) saveSetup()
}

const saveSetup = () => patchShoot({
  product_id: form.product_id,
  shoot_date: form.shoot_date || null,
  submission_rate: Math.min(100, Math.max(0, Number(form.submission_pct) || 0)) / 100,
  runway_target: Math.max(1, Math.round(Number(form.runway_target) || 1)),
  broll_variations: Math.min(10, Math.max(1, Math.round(Number(form.broll_variations) || 1))),
  vo_variations: Math.min(50, Math.max(0, Math.round(Number(form.vo_variations) || 0))),
  wording_variations: Math.min(50, Math.max(0, Math.round(Number(form.wording_variations) || 0))),
  kit: form.kit,
  location_notes: form.location_notes.trim() || null,
  notes: form.notes.trim() || null
})

// --- people and channels ---------------------------------------------------
const peopleOptions = computed(() => allPeople.value
  .filter(person => person.active || bundle.value.people.some(p => p.id === person.id))
  .map(person => ({ label: person.name, value: person.id })))
const channelOptions = computed(() => allChannels.value
  .filter(channel => channel.active || channelIds.value.includes(channel.id))
  .map(channel => ({ label: channel.name, value: channel.id })))
const personIds = computed(() => bundle.value.people.map(person => person.id))

async function setPeople(next: string[]) {
  const added = next.filter(id => !personIds.value.includes(id))
  const removed = personIds.value.filter(id => !next.includes(id))
  for (const id of removed) {
    const count = bundle.value.items.filter(item => item.person_id === id).length
    const name = bundle.value.people.find(person => person.id === id)?.name
    if (count && !(await confirmDialog({
      title: `Remove ${name} from this shoot?`,
      description: `Their ${count} item${count === 1 ? '' : 's'} on the structure go too, along with any per-person wording and ticks.`,
      confirmLabel: 'Remove',
      danger: true
    }))) return
  }
  await run(async () => {
    await setShootPeople(db, bundle.value, next)
    await refresh()
    // newcomers film the whole shot list, for each of the shoot's channels they're linked to
    if (await fillMissing()) await refresh()
  })
}

async function setChannels(next: string[]) {
  await run(async () => {
    await setShootChannels(db, bundle.value, next)
    await refresh()
    // everyone linked to a new channel films the shot list for it too
    if (await fillMissing()) await refresh()
  })
}

/** Everyone on a draft films every entry on each of their channels (see fillMissingItems). */
const fillMissing = () => fillMissingItems(db, bundle.value)
onMounted(async () => {
  if (await fillMissing().catch(() => 0)) await refresh()
})

// --- shot list ---------------------------------------------------------------
// Everyone on the shoot films the same list, once for each channel they're linked to: each
// hook / VO / CTA is one entry with one shared code and location, and there's an item per
// person per channel underneath for its own clip, status and, optionally, own wording.
const groups = computed(() => groupShotList(bundle.value.items))
const groupsOf = (kind: string) => groups.value.filter(group => group.kind === kind)

// --- adding and removing -----------------------------------------------------
const pickerOpen = ref(false)
const existingTemplates = computed(() => groups.value.map(group => group.template_id))

async function addItems(picked: PickedItems) {
  if (!bundle.value.people.length) return
  let added = 0
  await run(async () => {
    added = (await addToShotList(db, bundle.value, picked)).length
    await refresh()
  })
  if (added) toast.add({ title: `Added ${added} item${added === 1 ? '' : 's'} to the structure`, color: 'success', icon: 'i-lucide-circle-check' })
}

// --- writing a hook here ----------------------------------------------------
// A hook written in the shoot is this shoot's own: it isn't in the Library, and goes on the shot
// list for everyone like a picked one. If it works, "Save to product" (on its row) keeps it for
// the product's later shoots.
const writeHookOpen = ref(false)
const newHook = reactive({ script: '', caption: '', filming_notes: '' })
const requestWriteHookOpen = useGuardedClose(writeHookOpen, newHook)
function openWriteHook() {
  Object.assign(newHook, { script: '', caption: '', filming_notes: '' })
  writeHookOpen.value = true
}
const savingHook = ref(false)
async function writeHook() {
  const script = newHook.script.trim()
  if (!script) return
  savingHook.value = true
  const ok = await run(async () => {
    const hook = mustOne(await db.from('hook_templates').insert({
      script,
      caption: newHook.caption.trim() || null,
      filming_notes: newHook.filming_notes.trim() || null,
      est_seconds: estimateSeconds(script, Number(settings.value?.words_per_second) || DEFAULT_WORDS_PER_SECOND) || null,
      shoot_id: shoot.value.id
    }).select('*').single())
    await addItems({ hooks: [hook], bodies: [], ctas: [] })
  })
  savingHook.value = false
  if (ok) writeHookOpen.value = false
}

// --- writing a CTA here -----------------------------------------------------
// Like a hook written here: this shoot's own until "Save to product" on its row.
const ctaModes = [{ label: 'Sync (on camera)', value: 'sync' }, { label: 'VO over b-roll', value: 'vo' }]
const writeCtaOpen = ref(false)
const newCta = reactive({ script: '', mode: 'sync' })
const requestWriteCtaOpen = useGuardedClose(writeCtaOpen, newCta)
function openWriteCta() {
  Object.assign(newCta, { script: '', mode: 'sync' })
  writeCtaOpen.value = true
}
const savingCta = ref(false)
async function writeCta() {
  const script = newCta.script.trim()
  if (!script) return
  savingCta.value = true
  const ok = await run(async () => {
    const cta = mustOne(await db.from('cta_templates').insert({
      script,
      mode: newCta.mode,
      est_seconds: estimateSeconds(script, Number(settings.value?.words_per_second) || DEFAULT_WORDS_PER_SECOND) || null,
      shoot_id: shoot.value.id
    }).select('*').single())
    await addItems({ hooks: [], bodies: [], ctas: [cta] })
  })
  savingCta.value = false
  if (ok) writeCtaOpen.value = false
}

/** Shared fields (channel, location) apply to everyone's item. */
/** Shared by everyone filming a group: channel, location, or (edit for everyone) the shoot's own copy of the script. */
async function updateGroup(group: ShotGroup, patch: { channel_id?: string | null, location?: string | null, script_snapshot?: string | Beat[] }) {
  await run(async () => {
    must(await db.from('shoot_items').update(patch as Update<'shoot_items'>).in('id', group.items.map(item => item.id)))
    for (const item of group.items) Object.assign(item, patch)
  })
}

/** One person's own wording (override). */
async function updateItem(item: BundleItem, patch: { channel_id?: string | null, location?: string | null, script_override?: string | Beat[] | null, script_snapshot?: string | Beat[] }) {
  await run(async () => {
    must(await db.from('shoot_items').update(patch as Update<'shoot_items'>).eq('id', item.id))
    Object.assign(item, patch)
  })
}

const KIND_NOUNS: Record<string, string> = { hook: 'hook', body: 'VO', cta: 'CTA' }

async function removeGroup(group: ShotGroup) {
  const noun = KIND_NOUNS[group.kind] ?? 'item'
  const people = group.items.length
  if (!(await confirmDialog({
    title: `Remove ${noun} ${group.code} from this shoot?`,
    description: `It comes off for ${people === 1 ? 'the 1 person' : `all ${people} people`} filming it, along with any per-person wording and ticks.`
      + ' If it was written here and no other shoot uses it, it\'s deleted.',
    confirmLabel: 'Remove',
    danger: true
  }))) return
  await run(async () => {
    await removeFromShotList(db, bundle.value, [group])
    await refresh()
  })
}

const deleteUnused = (kind: string, templateIds: string[]) => deleteUnusedTemplates(db, shoot.value.id, kind, templateIds)

// --- writing VOs here -------------------------------------------------------
// VOs are only written in a shoot: for its product (one feature, or the product as a whole), by
// the signed-in user's person on the cast, who alone performs it (and, with admins, edits it).
// Saving puts it on the plan for its writer on each of their channels; editing it keeps this
// shoot's lines in step.
const voEditor = useTemplateRef<{ edit: (row?: Partial<Row<'body_templates'>>) => void }>('voEditor')
const writeVo = (format?: BrollFormat) => voEditor.value?.edit(format ? { format_id: format.id } : undefined)
async function editVo(group: ShotGroup) {
  await run(async () => {
    voEditor.value?.edit(mustOne(await db.from('body_templates').select('*').eq('id', group.template_id).single()))
  })
}
async function onVoSaved(vo: Row<'body_templates'>) {
  if (!groupsOf('body').some(entry => entry.template_id === vo.id)) {
    await addItems({ hooks: [], bodies: [vo], ctas: [] })
    return
  }
  await run(async () => {
    await syncVoOnPlan(db, bundle.value, vo)
    await refresh()
  })
}
const voPickerOpen = ref(false)

// a VO's own link (?vo=<id>, e.g. one an AI app drafted, shared in chat) opens it in the editor:
// saving it puts it on the plan
const openedVo = ref<string | null>(null)
watch(() => [route.query.vo, !!voEditor.value] as const, async ([id, ready]) => {
  if (typeof id !== 'string' || !ready || openedVo.value === id) return
  openedVo.value = id
  await run(async () => {
    const vo = must(await db.from('body_templates').select('*').eq('id', id).eq('shoot_id', shoot.value.id).maybeSingle())
    if (!vo) throw new Error('That VO isn\'t on this shoot.')
    voEditor.value?.edit(vo)
  })
}, { immediate: true })

async function renumber() {
  await run(async () => {
    must(await db.rpc('renumber_shoot_items', { p_shoot_id: shoot.value.id }))
    await refresh()
  }, 'Codes re-numbered')
}

/** The Library picker opens on hooks (Hooks tab) or CTAs (CTAs tab). */
const pickerKind = ref<'hook' | 'cta'>('hook')
function openPicker(kind: 'hook' | 'cta') {
  pickerKind.value = kind
  pickerOpen.value = true
}

// VOs grouped by format (collapsed to start)
const openFormats = ref<Set<string>>(new Set())
function toggleFormat(id: string) {
  const next = new Set(openFormats.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openFormats.value = next
}
const vosOfFormat = (formatId: string) => groupsOf('body').filter(group => group.items[0]?.format?.id === formatId)

/** Earlier VOs for this product: all of them, or one format's. */
const pickerFormat = ref<BrollFormat | null>(null)
function openVoPicker(format: BrollFormat | null = null) {
  pickerFormat.value = format
  voPickerOpen.value = true
}

/** Every person's copy of each format's VOs, so removing a format can take them off the structure. */
const voItemIds = computed(() => {
  const ids: Record<string, string[]> = {}
  for (const item of bundle.value.items) if (item.kind === 'body' && item.format?.id) (ids[item.format.id] ??= []).push(item.id)
  return ids
})

/** b-roll shots per format, for the remove-format confirmation */
// --- clearing sections -------------------------------------------------------
// Every Clear asks first, through one shared dialog, and lists what will go.
const confirmClear = ref<{ title: string, lines: string[], action: () => Promise<void> } | null>(null)
const clearing = ref(false)

async function deleteIds(table: 'shoot_items' | 'broll_shots', ids: string[]) {
  for (let i = 0; i < ids.length; i += 200) must(await db.from(table).delete().in('id', ids.slice(i, i + 200)))
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const KIND_WORDS: Record<string, string> = { hook: 'hook', body: 'VO', cta: 'CTA' }

function clearStructure(kind: 'hook' | 'body' | 'cta' | null) {
  const targets = kind ? groupsOf(kind) : groups.value
  if (!targets.length) return
  const ids = targets.flatMap(group => group.items.map(item => item.id))
  confirmClear.value = {
    title: kind ? `Clear all ${KIND_WORDS[kind]}s?` : 'Clear the whole structure?',
    lines: [
      kind
        ? `${plural(targets.length, KIND_WORDS[kind]!)} come off the structure for everyone.`
        : `${plural(groupsOf('hook').length, 'hook')}, ${plural(groupsOf('body').length, 'VO')} and ${plural(groupsOf('cta').length, 'CTA')} come off the structure for everyone.`,
      'Per-person versions, locations and ticks on those items go too.'
    ],
    action: async () => {
      await deleteIds('shoot_items', ids)
      for (const each of ['hook', 'body', 'cta']) await deleteUnused(each, targets.filter(group => group.kind === each).map(group => group.template_id))
    }
  }
}

function clearFormats() {
  const vos = groupsOf('body')
  const formatShots = bundle.value.broll.filter(shot => shot.format_id)
  confirmClear.value = {
    title: 'Clear all formats?',
    lines: [
      `${plural(shootFormats.value.length, 'format')} come off the plan.`,
      ...(vos.length ? [`All ${plural(vos.length, 'VO')} come off the structure for everyone.`] : []),
      ...(formatShots.length ? [`${plural(formatShots.length, 'b-roll shot')} in their sections go too. General product shots stay.`] : [])
    ],
    action: async () => {
      await deleteIds('shoot_items', vos.flatMap(group => group.items.map(item => item.id)))
      await deleteUnused('body', vos.map(group => group.template_id))
      await deleteIds('broll_shots', formatShots.map(shot => shot.id))
      must(await db.from('shoot_formats').delete().eq('shoot_id', shoot.value.id))
    }
  }
}

function clearBroll() {
  const shots = bundle.value.broll
  if (!shots.length) return
  confirmClear.value = {
    title: 'Clear all b-roll?',
    lines: [`${plural(shots.length, 'b-roll shot')} go, including general product shots.`, 'Formats and their sections stay.'],
    action: () => deleteIds('broll_shots', shots.map(shot => shot.id))
  }
}

async function runClear() {
  const pending = confirmClear.value
  if (!pending) return
  clearing.value = true
  await run(async () => {
    await pending.action()
    await refresh()
  }, 'Cleared')
  clearing.value = false
  confirmClear.value = null
}


const brollCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const shot of bundle.value.broll) if (shot.format_id) counts[shot.format_id] = (counts[shot.format_id] ?? 0) + 1
  return counts
})
/**
 * Formats on the plan, each with a b-roll section: the ones added by hand plus every format
 * the shoot's VOs use. Removing a format takes its VOs off the structure.
 */
const shootFormats = computed<BrollFormat[]>(() => {
  const formats = new Map<string, BrollFormat>()
  for (const format of bundle.value.plannedFormats) {
    formats.set(format.id, { ...format, usedBy: [], planned: true })
  }
  for (const group of groupShotList(bundle.value.items).filter(group => group.kind === 'body')) {
    const format = group.items[0]!.format
    if (!format?.id) continue
    const entry = formats.get(format.id) ?? {
      id: format.id,
      code: format.code,
      name: format.name ?? format.code,
      description: format.description ?? null,
      beats: format.beats,
      beat_descriptions: format.beat_descriptions ?? null,
      beat_broll: format.beat_broll ?? null,
      kind: format.kind,
      beat_display: format.beat_display ?? null,
      usedBy: [],
      planned: false
    }
    entry.usedBy.push(group.code)
    formats.set(format.id, entry)
  }
  return [...formats.values()].sort((a, b) => a.code.localeCompare(b.code))
})

// --- calculator ------------------------------------------------------------
const result = computed(() => calculate(bundleToCalcInput(bundle.value, toCalcSettings(settings.value, DEFAULT_CALC_SETTINGS))))
const unfilled = computed(() => unfilledItems(bundle.value))
const calculatorOpen = ref(false)
/** the Treatments card on General starts collapsed */
const treatmentsOpen = ref(false)

// --- status ----------------------------------------------------------------
const blockers = computed(() => planBlockers(bundle.value))

// --- back to draft -------------------------------------------------------------
// Only from planned (before the shoot starts): once filming begins, footage may already be
// filed under these codes, so started or filmed shoots stay locked.
// Revert: a shoot that's started (or ended) goes back to planned as if it never started, so it
// can then go back to draft. Ticks, b-roll counts and clip records are cleared; phones drop the
// clips they saved; anything already uploaded to Dropbox stays there.
const confirmRevert = ref(false)
async function revertShoot() {
  busy.value = true
  const ok = await run(async () => {
    must(await db.rpc('revert_shoot', { p_shoot_id: shoot.value.id }))
    // and forget which clips were on whose phone (the phones drop the clips themselves)
    must(await db.from('shoot_clips').delete().eq('shoot_id', shoot.value.id))
    await refresh()
  }, 'Shoot reverted. It\'s planned again, as if it never started.')
  busy.value = false
  if (ok) confirmRevert.value = false
}

const confirmUnplan = ref(false)
async function backToDraft() {
  busy.value = true
  const ok = await run(async () => {
    must(await db.from('shoots').update({ status: 'draft' }).eq('id', shoot.value.id).eq('status', 'planned'))
    await refresh()
  }, 'Back to draft. The plan can be edited again.')
  busy.value = false
  if (ok) confirmUnplan.value = false
}

// Live back to editing: only once it has no batches (they name its recipes by id). Going Live
// again checks Klip's edits and rebuilds the manifest and every recipe.
async function backToEditing() {
  if (!(await confirmDialog({
    title: `Take ${shoot.value.code} back to editing?`,
    description: 'It stops being Live. Check Klip\'s edits again and go Live to rebuild the manifest and recipes. Nothing in Dropbox is deleted.',
    confirmLabel: 'Back to editing'
  }))) return
  busy.value = true
  await run(async () => {
    must(await db.from('shoots').update({ status: 'editing' }).eq('id', shoot.value.id).eq('status', 'edited'))
    await refresh()
  }, 'Back to editing')
  busy.value = false
}

const confirmPlan = ref(false)

// --- stale ---------------------------------------------------------------------
// Any time, an admin can mark a shoot stale: archived from view (the shoots list and brand pages hide
// it) with its status left as it was. Unmarking brings it back.
const stale = computed(() => !!shoot.value.stale_at)
const confirmStale = ref(false)
async function setStale(value: boolean) {
  busy.value = true
  const ok = await run(async () => {
    const by = value ? (await db.auth.getUser()).data.user?.id ?? null : null
    must(await db.from('shoots').update({ stale_at: value ? new Date().toISOString() : null, stale_by: by }).eq('id', shoot.value.id))
    await refresh()
  }, value ? 'Marked stale: archived from the shoots list' : 'No longer stale')
  busy.value = false
  if (ok) confirmStale.value = false
}

// The shoot's whole folder tree in Dropbox (raw/, edited/, renders/ and the plan's manifest.json), made
// once it's planned and again before uploads. Folders already there are left as they are.
const dropbox = useDropbox()
const buildingTree = ref(false)
async function createDropboxFolders(quiet = false) {
  const status = await dropbox.ensure()
  if (!status?.connected) {
    if (!quiet) toast.add({ title: 'Dropbox isn\'t connected', description: 'Someone on the team can connect it in Settings → Dropbox.', color: 'warning', icon: 'i-lucide-cloud-off' })
    return
  }
  buildingTree.value = true
  try {
    const result = await $fetch('/api/dropbox/tree', { method: 'POST', body: { shootCode: shoot.value.code } })
    toast.add({
      title: result.created ? `Created ${result.created} folder${result.created === 1 ? '' : 's'} in Dropbox` : 'Dropbox folders are up to date',
      description: result.failed ? `${result.failed} couldn't be created. Try again.` : result.root,
      color: result.failed ? 'warning' : 'success',
      icon: 'i-simple-icons-dropbox'
    })
  } catch (error) {
    toast.add({
      title: 'Couldn\'t create the Dropbox folders',
      description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Try again from Export → Create folders in Dropbox.',
      color: 'error',
      icon: 'i-lucide-cloud-alert'
    })
  } finally {
    buildingTree.value = false
  }
}

async function markPlanned() {
  if (blockers.value.length) return
  busy.value = true
  const planned = await run(async () => {
    // freezes the filled scripts into the snapshots so later template or product edits can't change this shoot
    await planShoot(db, bundle.value)
    await refresh()
  }, {
    title: 'Shoot planned: codes and scripts are frozen',
    description: 'Library and product edits no longer affect it. You can still add per-person wording, locations and b-roll shots. Exports are ready.'
  })
  busy.value = false
  confirmPlan.value = false
  if (planned) createDropboxFolders(true)
}

/** Shots still to film: items and b-roll that are neither filmed nor skipped. */
const remaining = computed(() =>
  [...bundle.value.items, ...bundle.value.broll].filter(entry => entry.status === 'planned').length
)
const { nameOf } = useUsers()
const timeOf = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function download(format: string) {
  if (unfilled.value.length) {
    toast.add({ title: 'Unfilled slots block exports', description: unfilled.value.map(entry => entry.code).join(', '), color: 'error' })
    return
  }
  window.location.assign(`/api/shoots/${shoot.value.code}/export?format=${format}`)
}

const exportItems = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'manifest.json (plan)', icon: 'i-lucide-braces', onSelect: () => download('json') },
    { label: 'CSV', icon: 'i-lucide-table', onSelect: () => download('csv') },
    { label: 'Folder skeleton (zip)', icon: 'i-lucide-folder-archive', onSelect: () => download('zip') }
  ],
  [
    {
      label: buildingTree.value ? 'Creating folders…' : 'Create folders in Dropbox',
      description: 'Only adds what\'s missing',
      icon: 'i-simple-icons-dropbox',
      disabled: buildingTree.value,
      onSelect: () => createDropboxFolders()
    }
  ]
])

/**
 * The navbar's less-used actions, in one menu: exports, re-numbering, moving the shoot back, and
 * stale. The next step (Mark as planned, or the checklist and Start / End) stays a button.
 */
const actionItems = computed<DropdownMenuItem[][]>(() => {
  const admin = isAdmin.value
  const status = shoot.value.status
  return [
    isDraft.value
      ? (admin ? [{ label: 'Re-number codes', icon: 'i-lucide-list-ordered', onSelect: renumber }] : [])
      : [{ label: 'Export', icon: 'i-lucide-download', children: exportItems.value }],
    [
      ...(admin && status === 'planned' ? [{ label: 'Back to draft', icon: 'i-lucide-lock-open', onSelect: () => { confirmUnplan.value = true } }] : []),
      ...(admin && status === 'filmed' && remaining.value > 0 ? [{ label: 'Resume shoot', icon: 'i-lucide-rotate-ccw', onSelect: () => controls.value?.resume() }] : []),
      ...(admin && (status === 'shooting' || status === 'filmed') ? [{ label: 'Revert to planned', icon: 'i-lucide-history', onSelect: () => { confirmRevert.value = true } }] : []),
      ...(admin && status === 'editing' ? [{ label: 'Back to filmed', icon: 'i-lucide-undo-2', onSelect: () => editing.value?.backToFilmed() }] : []),
      ...(admin && status === 'edited'
        ? [{
            label: 'Back to editing',
            icon: 'i-lucide-scissors',
            disabled: loop.batches.value.length > 0,
            description: loop.batches.value.length ? 'Reset its batches first (Batches tab)' : undefined,
            onSelect: backToEditing
          }]
        : []),
      ...(admin
        ? [{
            label: stale.value ? 'Not stale' : 'Mark stale',
            icon: stale.value ? 'i-lucide-archive-restore' : 'i-lucide-archive',
            onSelect: () => stale.value ? setStale(false) : (confirmStale.value = true)
          }]
        : [])
    ]
  ].filter(group => group.length)
})
</script>

<template>
  <UDashboardPanel id="shoot">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" to="/shoots" aria-label="Back to shoots" />
        </template>
        <template #title>
          <span class="font-mono">{{ shoot.code }}</span>
          <span class="hidden font-normal text-muted sm:inline"> · {{ bundle.brand.name }} — {{ bundle.product.name }}</span>
        </template>
        <template #trailing>
          <UBadge :label="SHOOT_STATUS_LABELS[shoot.status] ?? shoot.status" :color="SHOOT_STATUS_COLORS[shoot.status]" variant="subtle" />
          <UBadge v-if="stale" label="Stale" color="neutral" variant="outline" />
        </template>
        <template #right>
          <ShareToChat :share="{ type: 'shoot', id: shoot.id, title: `${shoot.code} · ${bundle.brand.name} — ${bundle.product.name}`, preview: SHOOT_STATUS_LABELS[shoot.status] ?? shoot.status, path: `/shoots/${shoot.code}` }" />
          <UDropdownMenu v-if="actionItems.length" :items="actionItems" :content="{ align: 'end' }">
            <UButton
              label="Actions"
              aria-label="More actions"
              icon="i-lucide-ellipsis"
              color="neutral"
              variant="subtle"
              :loading="busy && !isDraft"
              :ui="ICON_ON_MOBILE"
              class="max-sm:px-1.5"
            />
          </UDropdownMenu>
          <template v-if="isDraft">
            <UButton
              v-if="isAdmin"
              label="Mark as planned"
              aria-label="Mark as planned"
              :ui="ICON_ON_MOBILE"
              class="max-sm:px-1.5"
              icon="i-lucide-lock"
              :disabled="blockers.length > 0"
              :loading="busy"
              @click="confirmPlan = true"
            />
          </template>
          <template v-else>
            <UButton
              label="Checklist"
              aria-label="Checklist"
              :ui="ICON_ON_MOBILE"
              class="max-sm:px-1.5"
              icon="i-lucide-clipboard-check"
              :color="shoot.status === 'shooting' ? 'primary' : 'neutral'"
              :variant="shoot.status === 'shooting' ? 'solid' : 'subtle'"
              :to="`/shoots/${shoot.code}/sheet`"
            />
            <ShootControls ref="controls" :shoot="shoot" :remaining="remaining" icon-on-mobile no-resume @changed="refresh" />
            <!-- filmed → editing → Live: the next step, as for every other status -->
            <template v-if="isAdmin && editing">
              <UButton
                v-if="shoot.status === 'filmed'"
                label="Send for editing"
                aria-label="Send for editing"
                :ui="ICON_ON_MOBILE"
                class="max-sm:px-1.5"
                icon="i-lucide-scissors"
                :loading="editing.starting"
                @click="editing.startEditing()"
              />
              <template v-else-if="shoot.status === 'editing'">
                <UButton
                  :label="editing.checking ? 'Checking…' : editing.result ? 'Check again' : 'Check edits'"
                  aria-label="Check edits"
                  :ui="ICON_ON_MOBILE"
                  class="max-sm:px-1.5"
                  icon="i-lucide-scan-search"
                  :color="editing.result ? 'neutral' : 'primary'"
                  :variant="editing.result ? 'subtle' : 'solid'"
                  :loading="editing.checking"
                  @click="editing.check()"
                />
                <UButton
                  v-if="editing.result"
                  :label="editing.result.ok ? 'Go Live' : 'Go Live anyway'"
                  aria-label="Go Live"
                  :ui="ICON_ON_MOBILE"
                  class="max-sm:px-1.5"
                  :icon="editing.result.ok ? 'i-lucide-radio' : 'i-lucide-triangle-alert'"
                  :color="editing.result.ok ? 'success' : 'error'"
                  :variant="editing.result.ok ? 'solid' : 'subtle'"
                  :loading="editing.saving"
                  @click="editing.goLive(!editing.result.ok)"
                />
              </template>
            </template>
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-4">
        <!-- Live: how much of the recipes the batches have used -->
        <section v-if="live" class="rounded-lg border border-default p-3 sm:p-4" aria-label="Recipes used">
          <PlannerBatchUsage :loop="loop" />
        </section>
        <!-- Summary: the calculator's headline numbers; the full calculator opens from here -->
        <section v-else class="rounded-lg border border-default p-3 sm:p-4" aria-label="Shoot summary">
          <div class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <p class="text-xs text-muted">
                Recipes
              </p>
              <p class="text-xl font-semibold text-highlighted tabular-nums">
                {{ formatNumber(result.totals.recipes) }}
              </p>
            </div>
            <div>
              <p class="text-xs text-muted">
                Est. submissions · {{ formatNumber(Number(shoot.submission_rate) * 100, 1) }}%
              </p>
              <p class="text-xl font-semibold text-primary tabular-nums">
                {{ formatNumber(result.totals.submissions) }}
              </p>
            </div>
            <div>
              <p class="text-xs text-muted">
                Hooks · VOs · CTAs
              </p>
              <p class="font-medium text-highlighted tabular-nums">
                {{ groupsOf('hook').length }} · {{ groupsOf('body').length }} · {{ groupsOf('cta').length }}
              </p>
            </div>
            <div>
              <p class="text-xs text-muted">
                People · channels
              </p>
              <p class="truncate font-medium text-highlighted" :title="bundle.people.map(person => person.name).join(', ')">
                {{ bundle.people.length }} · {{ bundle.channels.length }}
              </p>
            </div>
            <div>
              <p class="text-xs text-muted">
                {{ shoot.shoot_date ? new Date(`${shoot.shoot_date}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'No date yet' }}
              </p>
              <p class="font-medium text-highlighted tabular-nums">
                {{ result.totals.shootDays }} day{{ result.totals.shootDays === 1 ? '' : 's' }}
                <span class="text-xs font-normal text-muted">· {{ formatNumber(result.totals.onCameraHours, 1) }}h on camera</span>
              </p>
            </div>
            <div class="flex items-center justify-between gap-2 max-lg:col-span-2 sm:max-lg:col-span-1">
              <button
                v-if="(isDraft ? blockers.length : 0) + unfilled.length"
                type="button"
                class="text-left"
                @click="tab = 'general'"
              >
                <p class="text-xs text-muted">
                  To check
                </p>
                <p class="flex items-center gap-1 font-medium text-warning tabular-nums">
                  <UIcon name="i-lucide-triangle-alert" class="size-4" />
                  {{ (isDraft ? blockers.length : 0) + unfilled.length }}
                </p>
              </button>
              <div v-else>
                <p class="text-xs text-muted">
                  B-roll shots
                </p>
                <p class="font-medium text-highlighted tabular-nums">
                  {{ result.totals.brollShots }}
                </p>
              </div>
              <!-- the calculator's warnings live in the calculator: the button says how many -->
              <UChip :text="result.warnings.length" :show="result.warnings.length > 0" color="warning" size="3xl">
                <UButton
                  icon="i-lucide-calculator"
                  size="lg"
                  :color="result.warnings.length ? 'warning' : 'neutral'"
                  variant="subtle"
                  :aria-label="result.warnings.length ? `Calculator: ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : 'Calculator'"
                  :title="result.warnings.length ? `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} in the calculator` : undefined"
                  @click="calculatorOpen = true"
                />
              </UChip>
            </div>
          </div>
        </section>

        <!-- filmed → editing (Klip) → Live: run from the top bar; while editing, Klip's progress and the check -->
        <PlannerEditing v-if="isAdmin && (shoot.status === 'filmed' || shoot.status === 'editing')" ref="editing" :bundle="bundle" @changed="refresh" />

        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          class="w-full min-w-0"
          :ui="{ list: 'overflow-x-auto overflow-y-hidden', label: 'truncate max-sm:sr-only' }"
        />

        <!-- Batches (Live): make, track and measure them -->
        <PlannerBatches v-if="tab === 'batches'" :bundle="bundle" :loop="loop" @changed="refresh" />

        <!-- General: setup, slots and what's left to do -->
        <div v-else-if="tab === 'general'" class="space-y-6">
          <UAlert
            v-if="isDraft && blockers.length"
            color="neutral"
            variant="subtle"
            icon="i-lucide-list-checks"
            title="Before this shoot can be planned"
          >
            <template #description>
              <ul class="list-disc pl-4">
                <li v-for="blocker in blockers" :key="blocker">
                  {{ blocker }}
                </li>
              </ul>
            </template>
          </UAlert>
          <!-- slots nothing fills yet: fill them here (drafts only; planning freezes the scripts) -->
          <PlannerSlotFiller v-if="isDraft" :bundle="bundle" @changed="refresh" />
          <UAlert
            v-if="shoot.started_at"
            :color="shoot.status === 'shooting' ? 'warning' : 'success'"
            variant="subtle"
            :icon="shoot.status === 'shooting' ? 'i-lucide-clapperboard' : 'i-lucide-check-check'"
          >
            <template #title>
              <span class="flex flex-wrap items-center gap-x-2">
                {{ shoot.status === 'shooting' ? 'Shoot in progress' : 'Shoot finished' }}
                <ShootElapsed :shoot="shoot" />
              </span>
            </template>
            <template #description>
              <p>Started {{ timeOf(shoot.started_at) }} by {{ nameOf(shoot.started_by) }}.</p>
              <p v-if="shoot.ended_at">
                Ended {{ timeOf(shoot.ended_at) }} by {{ nameOf(shoot.ended_by) }}.
              </p>
              <p>{{ remaining }} shot{{ remaining === 1 ? '' : 's' }} left to tick off.</p>
            </template>
          </UAlert>

          <!-- treatments that are on (Library → Treatments): what each adds to this shoot's recipes -->
          <UCard v-if="result.treatments.length" :ui="{ body: treatmentsOpen ? undefined : 'hidden' }">
            <template #header>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  class="flex items-center gap-2 text-left"
                  :aria-expanded="treatmentsOpen"
                  @click="treatmentsOpen = !treatmentsOpen"
                >
                  <UIcon name="i-lucide-chevron-right" class="size-4 text-muted transition-transform" :class="{ 'rotate-90': treatmentsOpen }" />
                  <h2 class="font-semibold text-highlighted">
                    Treatments
                  </h2>
                  <UBadge
                    :label="`${result.treatments.filter(treatment => treatment.recipes).length} of ${result.treatments.length} applied`"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  />
                </button>
                <NuxtLink to="/library?tab=treatments" class="text-xs text-muted hover:text-default">Library → Treatments</NuxtLink>
              </div>
            </template>
            <p class="mb-3 text-sm text-muted">
              Every recipe also gets a version for each treatment that applies to it. Klip makes a treated copy of each clip it applies to, and Showdog stitches them.
            </p>
            <ul class="divide-y divide-default">
              <li v-for="treatment in result.treatments" :key="treatment.name" class="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span class="text-highlighted">{{ treatment.name }}</span>
                <span v-if="treatment.recipes" class="text-primary tabular-nums">+{{ formatNumber(treatment.recipes) }} recipes</span>
                <span v-else class="text-right text-xs text-muted">Not applied: {{ treatment.why }}</span>
              </li>
            </ul>
          </UCard>

          <UCard :ui="{ body: live ? 'pointer-events-none opacity-75' : undefined }">
            <template #header>
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <h2 class="font-semibold text-highlighted">
                  Setup
                </h2>
                <CreatedBy :by="shoot.created_by" :at="shoot.created_at" />
              </div>
            </template>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="Product">
                <USelectMenu
                  v-model="form.product_id"
                  :items="productOptions"
                  value-key="value"
                  class="w-full"
                  :disabled="!isDraft || groupsOf('body').length > 0"
                  :title="groupsOf('body').length ? 'This shoot has VOs written for its product: remove them to change it' : undefined"
                  @update:model-value="saveSetup"
                />
              </UFormField>
              <UFormField label="Shoot date">
                <UInput v-model="form.shoot_date" type="date" class="w-full" :disabled="!isDraft" @change="saveSetup" />
              </UFormField>
              <UFormField label="People">
                <USelectMenu
                  :model-value="personIds"
                  :items="peopleOptions"
                  value-key="value"
                  multiple
                  placeholder="Add people"
                  class="w-full"
                  :disabled="!isDraft"
                  @update:model-value="setPeople"
                />
              </UFormField>
              <PlannerGuests v-if="isAdmin" :shoot-id="shoot.id" :shoot-code="shoot.code" :channels="bundle.channels" :draft="isDraft" @changed="refresh" />
              <UFormField label="Channels" help="Defaults to the brand's channels">
                <USelectMenu
                  :model-value="channelIds"
                  :items="channelOptions"
                  value-key="value"
                  multiple
                  placeholder="Add channels"
                  class="w-full"
                  :disabled="!isDraft"
                  @update:model-value="setChannels"
                />
              </UFormField>
              <UFormField label="Batch size" help="The share of this shoot's valid recipes each batch submits.">
                <UInput v-model.number="form.submission_pct" type="number" min="0" max="100" step="0.5" class="w-full" @change="saveSetup">
                  <template #trailing>
                    <span class="text-xs text-muted">%</span>
                  </template>
                </UInput>
              </UFormField>
              <UFormField label="Target per channel" help="Submissions per channel per month. The calculator shows each channel's runway (months of supply) against it.">
                <UInput v-model.number="form.runway_target" type="number" min="1" class="w-full" @change="saveSetup">
                  <template #trailing>
                    <span class="text-xs text-muted">/ month</span>
                  </template>
                </UInput>
              </UFormField>
              <UFormField label="B-roll variations" help="Different b-roll selections per hook + VO + CTA, each its own recipe (used in later batches). Also the clips each channel films of every b-roll shot.">
                <UInput v-model.number="form.broll_variations" type="number" min="1" max="10" class="w-full" :disabled="!isDraft" @change="saveSetup" />
              </UFormField>
              <UFormField label="Cast mixes" help="On a channel where a VO is cast on several people, how many mixes of their beats to make, alongside each person's own. 0 = no mixing.">
                <UInput v-model.number="form.vo_variations" type="number" min="0" max="50" class="w-full" :disabled="!isDraft" @change="saveSetup" />
              </UFormField>
              <UFormField label="Wording mixes" :help="`Where a VO's beats have other wordings, how many extra combinations of them to make per person, alongside the first wordings. 0 = first wordings only. Up to ${wordingMax} here. Can change until the first batch${live ? ' (in the Batches tab)' : ''}.`">
                <UInput v-model.number="form.wording_variations" type="number" min="0" :max="wordingMax" class="w-full" @change="saveWordings" />
              </UFormField>
              <UFormField label="Kit" help="Just a tag for this shoot (e.g. Audition = trial shoot for a new brand, Scale = full production). It doesn't change anything else.">
                <USelect v-model="form.kit" :items="kits" class="w-full" @update:model-value="saveSetup" />
              </UFormField>
              <UFormField label="Location notes">
                <UInput v-model="form.location_notes" class="w-full" @change="saveSetup" />
              </UFormField>
              <UFormField label="Notes" class="sm:col-span-2">
                <UTextarea v-model="form.notes" autoresize :rows="2" class="w-full" @change="saveSetup" />
              </UFormField>
            </div>
          </UCard>
        </div>

        <!-- the plan's tabs: locked once Live -->
        <fieldset v-else :disabled="live" class="m-0 min-w-0 border-0 p-0" :class="{ 'opacity-90': live }">
        <!-- Formats: the VO formats this shoot uses -->
        <UCard v-if="tab === 'formats'">
          <template #header>
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm text-muted">
                The VO formats this shoot uses. A VO's format is added when it's written, and removing a format takes its VOs with it.
              </p>
              <UButton
                v-if="isDraft && shootFormats.length"
                label="Clear"
                icon="i-lucide-trash-2"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="clearFormats"
              />
            </div>
          </template>
          <PlannerFormats
            :shoot-id="shoot.id"
            :product-id="shoot.product_id"
            :formats="shootFormats"
            :broll-counts="brollCounts"
            :vo-item-ids="voItemIds"
            :draft="isDraft"
            @changed="refresh"
          />
        </UCard>

        <!-- Hooks or CTAs: filmed by everyone -->
        <UCard v-else-if="tab === 'hooks' || tab === 'ctas'" :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted">
                Filmed by everyone.
              </p>
              <div v-if="isDraft" class="flex items-center gap-1">
                <UButton
                  v-if="groupsOf(tab === 'hooks' ? 'hook' : 'cta').length"
                  label="Clear"
                  icon="i-lucide-trash-2"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  @click="clearStructure(tab === 'hooks' ? 'hook' : 'cta')"
                />
                <UButton
                  :label="tab === 'hooks' ? 'Write a hook' : 'Write a CTA'"
                  icon="i-lucide-pen-line"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :disabled="!bundle.people.length"
                  @click="tab === 'hooks' ? openWriteHook() : openWriteCta()"
                />
                <UButton
                  label="Add from Library"
                  icon="i-lucide-plus"
                  size="sm"
                  :disabled="!bundle.people.length"
                  @click="openPicker(tab === 'hooks' ? 'hook' : 'cta')"
                />
              </div>
            </div>
          </template>

          <p v-if="!bundle.people.length" class="px-4 py-8 text-center text-sm text-muted">
            Add people in General first. Everyone films every {{ tab === 'hooks' ? 'hook' : 'CTA' }}.
          </p>
          <div v-else class="divide-y divide-default">
            <PlannerShotRow
              v-for="group in groupsOf(tab === 'hooks' ? 'hook' : 'cta')"
              :key="group.key"
              :group="group"
              :bundle="bundle"
              :draft="isDraft"
              :product-id="shoot.product_id"
              @update-group="updateGroup(group, $event)"
              @update-item="updateItem"
              @remove="removeGroup(group)"
            />
            <p v-if="!groupsOf(tab === 'hooks' ? 'hook' : 'cta').length" class="px-4 py-8 text-center text-sm text-muted">
              No {{ tab === 'hooks' ? 'hooks' : 'CTAs' }} yet. Write one here or add some from the Library.
            </p>
          </div>
        </UCard>

        <!-- VOs: written here, for this shoot's product, grouped by format -->
        <UCard v-else-if="tab === 'vos'" :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted">
                Performed only by their writer.
              </p>
              <div v-if="isDraft" class="flex items-center gap-1">
                <UButton
                  label="Earlier VOs"
                  icon="i-lucide-history"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :disabled="!bundle.people.length"
                  @click="openVoPicker()"
                />
                <UButton
                  label="Write a VO"
                  icon="i-lucide-pen-line"
                  size="sm"
                  :disabled="!bundle.people.length"
                  @click="writeVo()"
                />
              </div>
            </div>
          </template>

          <p v-if="!bundle.people.length" class="px-4 py-8 text-center text-sm text-muted">
            Add people in General first: each VO is written by someone on the shoot.
          </p>
          <template v-else>
            <div v-for="format in shootFormats" :key="format.id" class="border-b border-default last:border-b-0">
              <div class="flex items-center gap-3 bg-elevated/20 px-4 py-2.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 text-left"
                  :aria-expanded="openFormats.has(format.id)"
                  @click="toggleFormat(format.id)"
                >
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="size-4 shrink-0 text-muted transition-transform"
                    :class="{ 'rotate-90': openFormats.has(format.id) }"
                  />
                  <span class="truncate text-sm text-highlighted">
                    <span class="mr-1.5 font-mono font-semibold">{{ format.code }}</span>{{ format.name }}
                  </span>
                  <UBadge :label="`${vosOfFormat(format.id).length} VO${vosOfFormat(format.id).length === 1 ? '' : 's'}`" color="neutral" variant="outline" size="sm" class="shrink-0" />
                </button>
                <UButton
                  v-if="isDraft"
                  :label="`Write ${format.code}`"
                  icon="i-lucide-pen-line"
                  size="xs"
                  color="neutral"
                  variant="subtle"
                  @click="writeVo(format)"
                />
              </div>
              <div v-if="openFormats.has(format.id)" class="divide-y divide-default border-t border-default">
                <PlannerShotRow
                  v-for="group in vosOfFormat(format.id)"
                  :key="group.key"
                  :group="group"
                  :bundle="bundle"
                  :draft="isDraft"
                  :product-id="shoot.product_id"
                  @update-group="updateGroup(group, $event)"
                  @update-item="updateItem"
                  @remove="removeGroup(group)"
                  @edit-vo="editVo(group)"
                />
                <div v-if="!vosOfFormat(format.id).length" class="flex flex-wrap items-center gap-2 px-4 py-3 text-xs text-dimmed">
                  No {{ format.code }} VOs yet.
                  <UButton v-if="isDraft" :label="`Earlier ${format.code} VOs`" size="xs" color="neutral" variant="link" class="p-0" @click="openVoPicker(format)" />
                </div>
              </div>
            </div>
            <p v-if="!shootFormats.length" class="px-4 py-8 text-center text-sm text-muted">
              No VOs yet. Write one (its format joins the plan), or pick formats in the Formats tab first.
            </p>
          </template>
        </UCard>

        <!-- B-roll: shots to film for each format's beats, plus general product shots -->
        <UCard v-else>
          <template #header>
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm text-muted">
                A section for each format, by beat, plus general product shots. Shared by every channel.
              </p>
              <UButton
                v-if="isDraft && bundle.broll.length"
                label="Clear"
                icon="i-lucide-trash-2"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="clearBroll"
              />
            </div>
          </template>
          <PlannerBroll
            :shoot-id="shoot.id"
            :shoot-code="shoot.code"
            :product-id="shoot.product_id"
            :shots="bundle.broll"
            :formats="shootFormats"
            :draft="isDraft"
            :filmed-on="(shot) => brollChannelIds(bundle, shot).map(id => bundle.channels.find(channel => channel.id === id)?.name ?? 'the shoot')"
            :channel-count="bundle.channels.length"
            @changed="refresh"
          />
        </UCard>
        </fieldset>
      </div>

      <USlideover v-model:open="calculatorOpen" title="Calculator" :ui="{ content: 'max-w-md' }">
        <template #body>
          <PlannerCalculator :result="result" :submission-rate="Number(shoot.submission_rate)" :target="shoot.runway_target" :unfilled="unfilled" />
        </template>
      </USlideover>

      <UModal v-model:open="confirmPlan" :title="`Mark ${shoot.code} as planned?`">
        <template #body>
          <ul class="list-disc space-y-1 pl-5 text-sm text-default">
            <li>Codes are fixed and scripts are frozen with their slots filled in, so later Library or product edits won't change this shoot.</li>
            <li>The checklist, exports and folder skeleton become available.</li>
            <li>You can put it back to draft until the shoot starts.</li>
          </ul>
        </template>
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
            <UButton label="Mark as planned" icon="i-lucide-lock" :loading="busy" @click="markPlanned" />
          </div>
        </template>
      </UModal>

      <UModal v-model:open="confirmRevert" :title="`Revert ${shoot.code} to planned?`">
        <template #body>
          <div class="space-y-2 text-sm text-default">
            <p>The shoot goes back to planned, as if it never started. You can then put it back to draft.</p>
            <ul class="list-disc space-y-0.5 pl-4 text-muted">
              <li>Every tick and skip is cleared, and b-roll counts go back to zero.</li>
              <li>Clips saved on phones are discarded and won't upload.</li>
              <li>Anything already uploaded to Dropbox stays there.</li>
            </ul>
          </div>
        </template>
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
            <UButton label="Revert shoot" icon="i-lucide-history" color="error" :loading="busy" @click="revertShoot" />
          </div>
        </template>
      </UModal>

      <UModal v-model:open="confirmUnplan" :title="`Put ${shoot.code} back to draft?`">
        <template #body>
          <ul class="list-disc space-y-1 pl-5 text-sm text-default">
            <li>You can add and remove people, formats, hooks, VOs, CTAs and b-roll again, and re-number codes.</li>
            <li>Scripts already filled in keep their wording. You can still edit them per person.</li>
            <li>If you change codes, download the exports and folder skeleton again after re-planning.</li>
          </ul>
        </template>
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
            <UButton label="Back to draft" icon="i-lucide-lock-open" :loading="busy" @click="backToDraft" />
          </div>
        </template>
      </UModal>

      <UModal v-model:open="confirmStale" :title="`Mark ${shoot.code} as stale?`">
        <template #body>
          <ul class="list-disc space-y-1 pl-5 text-sm text-default">
            <li>It's archived from view: the shoots list and the brand's page hide it. The shoots list's Stale filter still finds it.</li>
            <li>Nothing else changes: its status, plan, footage and batches stay as they are.</li>
            <li>You can unmark it any time with Not stale.</li>
          </ul>
        </template>
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
            <UButton label="Mark stale" icon="i-lucide-archive" :loading="busy" @click="setStale(true)" />
          </div>
        </template>
      </UModal>

      <UModal :open="!!confirmClear" :title="confirmClear?.title" @update:open="confirmClear = $event ? confirmClear : null">
        <template #body>
          <ul class="list-disc space-y-1 pl-5 text-sm text-default">
            <li v-for="line in confirmClear?.lines ?? []" :key="line">
              {{ line }}
            </li>
          </ul>
        </template>
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
            <UButton label="Clear" color="error" icon="i-lucide-trash-2" :loading="clearing" @click="runClear" />
          </div>
        </template>
      </UModal>

      <UModal
        :open="writeHookOpen"
        title="Write a hook"
        description="For this shoot only. If it works, save it to the product from its row so later shoots can use it."
        :ui="{ content: 'sm:max-w-xl' }"
        @update:open="requestWriteHookOpen"
      >
        <template #body>
          <div class="space-y-4">
            <UFormField label="Script" required help="On camera, sync audio. Slots work: {{brand}}, {{product}}, your channel slots, or your own, filled in on this shoot.">
              <ScriptEditor v-model="newHook.script" placeholder="Nobody told me {{product}} could do this…" />
            </UFormField>
            <UFormField label="Suggested caption" help="Optional post caption for this hook">
              <ScriptEditor v-model="newHook.caption" :palette="false" />
            </UFormField>
            <UFormField label="How to film it" help="Optional: framing, action, props, delivery">
              <UTextarea v-model="newHook.filming_notes" autoresize :rows="2" class="w-full" />
            </UFormField>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="requestWriteHookOpen(false)" />
            <UButton label="Add to the shot list" icon="i-lucide-plus" :disabled="!newHook.script.trim()" :loading="savingHook" @click="writeHook" />
          </div>
        </template>
      </UModal>

      <UModal
        :open="writeCtaOpen"
        title="Write a CTA"
        description="For this shoot only. If it works, save it to the product from its row so later shoots can use it."
        :ui="{ content: 'sm:max-w-xl' }"
        @update:open="requestWriteCtaOpen"
      >
        <template #body>
          <div class="space-y-4">
            <UFormField label="Script" required help="Slots work: {{brand}}, {{product}}, your channel slots, or your own, filled in on this shoot.">
              <ScriptEditor v-model="newCta.script" placeholder="Tap the link and try {{product}} today" />
            </UFormField>
            <UFormField label="Mode" help="Sync is said on camera; VO is recorded as voiceover over b-roll.">
              <USelect v-model="newCta.mode" :items="ctaModes" class="w-full" />
            </UFormField>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="requestWriteCtaOpen(false)" />
            <UButton label="Add to the shot list" icon="i-lucide-plus" :disabled="!newCta.script.trim()" :loading="savingCta" @click="writeCta" />
          </div>
        </template>
      </UModal>

      <PlannerItemPicker
        v-model:open="pickerOpen"
        :kinds="[pickerKind]"
        :existing="existingTemplates"
        :product-id="shoot.product_id"
        :people-ids="personIds"
        @add="addItems"
      />
      <PlannerItemPicker
        v-model:open="voPickerOpen"
        :kinds="['body']"
        :existing="existingTemplates"
        :format="pickerFormat"
        :product-id="shoot.product_id"
        :people-ids="personIds"
        @add="addItems"
      />
      <PlannerVoEditor
        ref="voEditor"
        :shoot-id="shoot.id"
        :product-id="shoot.product_id"
        :people="bundle.people"
        :channels="bundle.channels"
        :channel-people="bundle.channelPeople ?? {}"
        @saved="onVoSaved"
      />
    </template>
  </UDashboardPanel>
</template>
