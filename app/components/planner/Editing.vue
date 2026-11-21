<script setup lang="ts">
import type { Json } from '#shared/types/database.types'
import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { BundleTreatment } from '#shared/utils/shootsheet'
import type { EditsCheck, Manifest } from '#shared/utils/manifest'
import type { KlipIndex } from '#shared/utils/klip'

// Filmed → Editing → Live (spec §14, docs/contract.md). Starting editing writes the plan's manifest
// (the plan, the treatments that are on, and its plan_hash) for Klip, which edits raw/ into building
// blocks in edited/ (each take's clip, captions, and what the treatments need) and writes its index,
// edited/_klip.json. Once it's done, someone checks its work: the index against the plan, raw/ and
// what's in edited/. Going Live writes the full manifest and every recipe (recipes.json), built from
// the index. Batches start from there. This runs in the browser, which talks to Dropbox directly.
const props = defineProps<{ bundle: LoadedShoot }>()
const emit = defineEmits<{ changed: [] }>()

const db = useDb()
const run = useAction()
const toast = useToast()
const { confirmDialog } = useConfirm()
const dropbox = useDropbox()
const shoot = computed(() => props.bundle.shoot)
const base = computed(() => shootFolder(props.bundle))

// the latest manifest: while editing, the one Klip was given
const latest = shallowRef<{ version: number, created_at: string, data: Manifest } | null>(null)
async function loadLatest() {
  const { data } = await db.from('shoot_manifests').select('version, created_at, data').eq('shoot_id', shoot.value.id).order('version', { ascending: false }).limit(1).maybeSingle()
  latest.value = data ? { ...data, data: data.data as unknown as Manifest } : null
}
onMounted(loadLatest)

/** The shoot as Klip was given it: the treatments it was told to make, even if the Library's changed since. */
const handedOff = computed(() => {
  const treatments = latest.value?.data.plan?.treatments as unknown as BundleTreatment[] | undefined
  // less one: Over b-roll was retired (hooks and CTAs never go over b-roll), and Klip makes nothing for it
  const overBroll = (treatment: BundleTreatment): boolean => (treatment.settings as { show?: string } | null)?.show === 'broll' || !!treatment.parts?.some(overBroll)
  return treatments ? { ...props.bundle, treatments: treatments.filter(treatment => !overBroll(treatment)) } : props.bundle
})
/** the treatments Klip makes something for, as it was given them */
const ingredients = computed(() => shootIngredients(handedOff.value))

async function connected() {
  const status = await dropbox.refresh().catch(() => null)
  if (!status?.connected) toast.add({ title: 'Dropbox isn\'t connected', description: 'Someone on the team can connect it in Settings → Dropbox.', color: 'warning', icon: 'i-lucide-cloud-off' })
  return status?.connected ? status : null
}

// --- filmed → editing ----------------------------------------------------------------
const starting = ref(false)
async function startEditing() {
  if (!(await confirmDialog({
    title: `Send ${shoot.value.code} for editing?`,
    description: 'Writes the manifest Klip works from (the plan and the treatments that are on) to the shoot\'s folder. Klip edits raw/ into edited/: each take\'s clip and captions, and whatever the treatments need.',
    confirmLabel: 'Send for editing'
  }))) return
  if (!(await connected())) return
  starting.value = true
  const version = (latest.value?.version ?? 0) + 1
  const ok = await run(async () => {
    // with signed links to static formats' example ads and the brand kit's files, for Kanvas
    const manifest = await withStaticLinks(db, { ...planManifest(props.bundle), version, generated_at: new Date().toISOString() })
    await dropboxUploader.writeText(`${base.value}/manifest.json`, JSON.stringify(manifest, null, 2))
    must(await db.from('shoot_manifests').insert({ shoot_id: shoot.value.id, version, data: manifest as unknown as Json }))
    must(await db.from('shoots').update({ status: 'editing' }).eq('id', shoot.value.id).eq('status', 'filmed'))
  }, 'Editing: Klip has its manifest')
  starting.value = false
  if (!ok) return
  await loadLatest()
  emit('changed')
}

async function backToFilmed() {
  await run(async () => {
    must(await db.from('shoots').update({ status: 'filmed' }).eq('id', shoot.value.id).eq('status', 'editing'))
  }, 'Back to filmed')
  emit('changed')
}

// --- checking Klip's work ----------------------------------------------------------
const checking = ref(false)
const result = ref<EditsCheck | null>(null)
let index: KlipIndex | null = null
let brollShots = new Map<string, string>()
/** each still's photos in raw/, for static recipes */
let stills: ReturnType<typeof stillAssets> = { product: {}, avatar: {} }

async function check() {
  const status = await connected()
  if (!status) return
  checking.value = true
  result.value = null
  try {
    const [raw, edited, indexText, clipRows] = await Promise.all([
      dropboxListFiles(`${base.value}/raw`),
      dropboxListFiles(`${base.value}/edited`),
      dropboxReadText(`${base.value}/edited/_klip.json`),
      db.from('shoot_clips').select('target, path, state').eq('shoot_id', shoot.value.id)
    ])
    const rows = clipRows.data ?? []
    // which b-roll shot each uploaded clip was for, by its place in raw/
    brollShots = new Map(rows
      .filter(row => row.target.startsWith('broll:') && row.path)
      .flatMap((row) => {
        const relative = relativeToStage(props.bundle, row.path!, status.root, 'raw')
        return relative ? [[relative, row.target.split(':')[1]!] as [string, string]] : []
      }))

    stills = stillAssets(raw.flatMap((file) => {
      const relative = relativeToStage(props.bundle, file.path, status.root, 'raw')
      return relative ? [relative] : []
    }))

    // Klip's index of what it made: lengths and all come from here
    let read: KlipIndex | { error: string } | null = null
    if (indexText !== null) {
      try {
        const parsed = parseKlipIndex(JSON.parse(indexText))
        read = parsed.index ?? { error: parsed.error }
      } catch {
        read = { error: 'Klip\'s index (edited/_klip.json) isn\'t valid JSON: Klip may still be writing it, so check again in a moment' }
      }
    }
    index = read && !('error' in read) ? read : null
    result.value = checkEdits(handedOff.value, raw.map(file => file.path), edited.map(file => file.path), read, {
      onPhones: rows.filter(row => row.state === 'saved').length,
      // the plan Klip was given
      planHash: latest.value?.data.plan_hash ?? planHash(handedOff.value)
    })
  } catch (error) {
    toast.add({ title: 'Couldn\'t read the shoot\'s folders', description: (error as Error).message, color: 'error', icon: 'i-lucide-cloud-alert' })
  } finally {
    checking.value = false
  }
}

// --- editing → Live ----------------------------------------------------------------------
const saving = ref(false)
/**
 * Go Live: write the manifest and every recipe. With problems, only when someone overrides them:
 * whatever's missing is left out (recipes needing it aren't made) and the problems are recorded.
 */
async function goLive(override = false) {
  if (!result.value || (!result.value.ok && !override)) return
  if (!index) {
    toast.add({ title: 'Klip\'s index isn\'t readable', description: 'Going Live builds everything from edited/_klip.json: check edits again once Klip has written it.', color: 'error' })
    return
  }
  const klip = index
  if (override && !(await confirmDialog({
    title: 'Go Live anyway?',
    description: `${result.value.problems.length} problem${result.value.problems.length === 1 ? '' : 's'} will be left as they are. Anything Klip didn't make stays out of the manifest, so recipes (and treated versions) that need it won't be made. The problems are noted in the manifest.`,
    confirmLabel: 'Go Live anyway'
  }))) return
  saving.value = true
  const version = (latest.value?.version ?? 0) + 1
  const ok = await run(async () => {
    const generatedAt = new Date().toISOString()
    const manifest = await withStaticLinks(db, buildManifest(handedOff.value, klip, {
      version,
      generatedAt,
      brollShots,
      stills,
      overridden: result.value!.ok ? undefined : result.value!.problems
    }))
    await writeLiveFiles(base.value, shoot.value.code, manifest)
    must(await db.from('shoot_manifests').insert({ shoot_id: shoot.value.id, version, data: manifest as unknown as Json }))
    must(await db.from('shoots').update({ status: 'edited' }).eq('id', shoot.value.id).eq('status', 'editing'))
  }, { title: 'Live: the recipes are built', description: 'The shoot is locked. Batches are made, tracked and measured in the Batches tab.' })
  saving.value = false
  if (!ok) return
  result.value = null
  await loadLatest()
  emit('changed')
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// collapsed by default; a check that finds problems opens it so they're seen
const open = ref(false)
watch(result, value => { if (value && !value.ok) open.value = true })

// the shoot page's top bar runs these: every status change lives there (next step) or in Actions (back)
defineExpose({ startEditing, backToFilmed, check, goLive, starting, checking, saving, result })
</script>

<template>
  <UCard v-if="shoot.status === 'editing'" :ui="{ header: open ? undefined : 'border-b-0', body: open ? 'space-y-3' : 'hidden' }">
    <template #header>
      <button type="button" class="flex w-full items-center gap-2 text-left" :aria-expanded="open" @click="open = !open">
        <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted transition-transform" :class="{ 'rotate-90': open }" />
        <UIcon name="i-lucide-scissors" class="size-4 shrink-0 text-warning" />
        <span class="flex-1 font-medium text-highlighted">Editing</span>
        <span v-if="latest" class="hidden text-xs text-muted sm:inline">Klip's manifest v{{ latest.version }}</span>
        <UBadge v-if="checking" label="Checking…" color="neutral" variant="subtle" size="sm" />
        <UBadge v-else-if="result?.ok" label="Checks out" color="success" variant="subtle" size="sm" />
        <UBadge v-else-if="result" :label="`${result.problems.length} to fix`" color="error" variant="subtle" size="sm" />
        <UBadge v-else label="Not checked" color="neutral" variant="outline" size="sm" />
      </button>
    </template>
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <p class="text-sm text-muted">
          <template v-if="latest">
            Klip's manifest v{{ latest.version }}, {{ when(latest.created_at) }}.
          </template>
          Once Klip's done, use <span class="font-medium text-highlighted">Check edits</span> at the top: its index (edited/_klip.json) is for this plan, every take is edited with its clip and captions, and every raw clip is accounted for<template v-if="ingredients.length">, with what {{ ingredients.map(treatment => treatment.name).join(', ') }} need</template>.
          Then <span class="font-medium text-highlighted">Go Live</span> builds every recipe from Klip's index.
        </p>
      </div>
    </div>

    <template v-if="result">
      <UAlert
        v-if="result.warnings.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-eye"
        :title="`Klip suggests a look at ${result.warnings.length} take${result.warnings.length === 1 ? '' : 's'}`"
        description="These don't stop the shoot going Live."
      >
        <template #description>
          <ul class="list-disc space-y-0.5 pl-4">
            <li v-for="warning in result.warnings.slice(0, 10)" :key="warning">
              {{ warning }}
            </li>
            <li v-if="result.warnings.length > 10">
              …and {{ result.warnings.length - 10 }} more
            </li>
          </ul>
        </template>
      </UAlert>
      <UAlert
        v-if="result.ok"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="`Everything checks out: ${result.editedClips} clips in edited/`"
        description="Go Live (at the top) builds every recipe."
      />
      <UAlert
        v-else
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        :title="`${result.problems.length} thing${result.problems.length === 1 ? '' : 's'} to fix first`"
      >
        <template #description>
          <ul class="list-disc space-y-0.5 pl-4">
            <li v-for="problem in result.problems.slice(0, 20)" :key="problem">
              {{ problem }}
            </li>
            <li v-if="result.problems.length > 20">
              …and {{ result.problems.length - 20 }} more
            </li>
          </ul>
          <p class="mt-3 text-xs text-muted">
            Go Live anyway (at the top) leaves out whatever's missing; recipes that need it won't be made.
          </p>
        </template>
      </UAlert>
    </template>
  </UCard>
</template>
