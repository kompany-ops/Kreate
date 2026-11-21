<script setup lang="ts">
import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { Score } from '#shared/utils/batchLoop'
import type { StaticElementKind, StaticRecipe } from '#shared/utils/staticRecipes'
import type { BatchRow, BatchStatus } from '~/composables/useBatchLoop'
import type { StaticBatchLoop } from '~/composables/useStaticBatchLoop'

// A Live shoot's static batches (statics spec §7), in the same loop as video's but apart from it:
// SB01, SB02… go batched → rendering (Kanvas) → submitted → measured. Before a batch is submitted its
// renders are reviewed from Kanvas's index: an ad whose product Kanvas drew must be approved or
// rejected (rejected ones are left out and can be batched again); other flags are warnings. Making
// one writes batches/SB01.json (+ CSV) and renders/SB01/<channel>/ for Kanvas; statics.json was
// written when the shoot went Live (docs/contract-kanvas.md).
const props = defineProps<{ bundle: LoadedShoot, loop: StaticBatchLoop }>()
const emit = defineEmits<{ changed: [] }>()

const db = useDb()
const { isAdmin } = useAccess()
const run = useAction()
const toast = useToast()
const dropbox = useDropbox()
const { confirmDialog } = useConfirm()
const shoot = computed(() => props.bundle.shoot)
const base = computed(() => shootFolder(props.bundle))
const loop = props.loop
const { batches, recipes, batched, records, canBatch } = loop

// --- the next static batch -----------------------------------------------------------------
const sizePct = ref(Math.round(Number(shoot.value.static_submission_rate) * 1000) / 10)
watch(() => shoot.value.static_submission_rate, value => sizePct.value = Math.round(Number(value) * 1000) / 10)
const size = computed(() => batchSize(recipes.value.length, Math.min(100, Math.max(0, Number(sizePct.value) || 0)) / 100))
async function saveSize() {
  const pct = Math.min(100, Math.max(0.5, Math.round((Number(sizePct.value) || 0) * 2) / 2))
  sizePct.value = pct
  if (pct === Math.round(Number(shoot.value.static_submission_rate) * 1000) / 10) return
  await run(async () => {
    must(await db.from('shoots').update({ static_submission_rate: pct / 100 }).eq('id', shoot.value.id))
  })
  emit('changed')
}
const exploitShare = computed(() => Number(shoot.value.exploit_share ?? DEFAULT_EXPLOIT_SHARE))
const nextCode = computed(() => nextStaticBatchCode(batches.value.map(batch => batch.code)))
const preview = computed(() => pickStaticBatch(recipes.value, { size: size.value, exclude: batched.value, exploitShare: exploitShare.value, records: records.value }))
const waitingOn = computed(() => batches.value.filter(batch => batch.status !== 'measured').map(batch => batch.code))
const usedPct = computed(() => Math.round(loop.used.value * 100))

const generating = ref(false)
async function generate() {
  const status = await dropbox.refresh().catch(() => null)
  if (!status?.connected) {
    toast.add({ title: 'Dropbox isn\'t connected', description: 'Someone on the team can connect it in Settings → Dropbox.', color: 'warning', icon: 'i-lucide-cloud-off' })
    return
  }
  generating.value = true
  const code = nextCode.value
  const pick = preview.value
  const chosen = staticBatchOrder(pick.recipes)
  const ok = await run(async () => {
    if (!canBatch.value) throw new Error(`Measure ${waitingOn.value.join(', ')} first`)
    if (!chosen.length) throw new Error('Nothing left to batch: every static recipe has been batched or has a dropped element')
    const manifestVersion = loop.manifest.value!.version
    await dropboxUploader.writeText(`${base.value}/batches/${code}.json`, JSON.stringify({
      schema_version: 1,
      shoot: shoot.value.code,
      batch: code,
      medium: 'static',
      manifest_version: manifestVersion,
      generated_at: new Date().toISOString(),
      pick: { exploit: pick.exploit, explore: pick.explore },
      // the recipes are in ../statics.json; render each into renders/<batch>/<channel>/<recipe id>.<size>.png
      statics_file: 'statics.json',
      renders_folder: `renders/${code}`,
      recipes: chosen.map(recipe => recipe.id)
    }, null, 2))
    await dropboxUploader.writeText(`${base.value}/batches/${code}.csv`, staticBatchCsv(chosen))
    for (const channel of new Set(chosen.map(recipe => recipe.channel))) await dropboxEnsureFolder(`${base.value}/${renderFolder(code, channel)}`)
    must(await db.from('shoot_shortlists').insert({
      shoot_id: shoot.value.id,
      code,
      medium: 'static',
      size: chosen.length,
      entry_ids: chosen.map(recipe => recipe.id),
      manifest_version: manifestVersion,
      exploit_share: exploitShare.value
    }))
  }, `${code}: ${chosen.length} static ad${chosen.length === 1 ? '' : 's'} batched`)
  generating.value = false
  if (ok) await loop.load()
}

// --- statuses, and reviewing renders before submitting ---------------------------------------
async function advance(batch: BatchRow, status: BatchStatus) {
  if (status === 'submitted') {
    await run(() => loop.readKanvas(base.value))
    const waiting = loop.undecided(batch)
    if (waiting.length) {
      reviewing.value = batch
      toast.add({ title: `Review ${batch.code} first`, description: `${waiting.length} ad${waiting.length === 1 ? ' has' : 's have'} a product Kanvas drew: approve or reject ${waiting.length === 1 ? 'it' : 'each'}.`, color: 'warning', icon: 'i-lucide-image' })
      return
    }
  }
  await run(() => loop.setStatus(batch, status), `${batch.code}: ${BATCH_STATUS_LABELS[status]}`)
}

const reviewing = ref<BatchRow | null>(null)
const reading = ref(false)
async function openReview(batch: BatchRow) {
  reviewing.value = batch
  reading.value = true
  await run(() => loop.readKanvas(base.value))
  reading.value = false
}
const reviewRecipes = computed(() => reviewing.value ? loop.batchRecipes(reviewing.value) : [])
const renderOf = (recipe: StaticRecipe) => reviewing.value ? loop.rendersOf(reviewing.value).get(recipe.id) ?? null : null
const planHashChanged = computed(() => !!loop.kanvas.value && !!loop.manifest.value?.plan_hash && loop.kanvas.value.plan_hash !== loop.manifest.value.plan_hash)
async function decide(recipe: StaticRecipe, decision: 'approved' | 'rejected') {
  if (!reviewing.value) return
  const next = loop.reviewOf(reviewing.value, recipe.id) === decision ? null : decision
  await run(() => loop.setReview(reviewing.value!, recipe.id, next))
}
const opening = ref<string | null>(null)
async function view(file: string) {
  const tab = window.open('', '_blank')
  opening.value = file
  try {
    const status = await dropbox.refresh()
    const url = await dropboxViewLink(`${status.root}/${base.value}/${file}`)
    if (tab) tab.location.href = url
  } catch {
    tab?.close()
    toast.add({ title: 'Couldn\'t open it in Dropbox', color: 'error', icon: 'i-lucide-cloud-alert' })
  } finally {
    opening.value = null
  }
}

// --- undo and reset (static batches only) --------------------------------------------------
const undoing = ref(false)
const latest = computed(() => batches.value.at(-1) ?? null)
async function removeFiles(codes: string[]) {
  const failed: string[] = []
  for (const code of codes) {
    for (const path of [`${base.value}/batches/${code}.json`, `${base.value}/batches/${code}.csv`, `${base.value}/renders/${code}`]) {
      await dropboxUploader.remove(path, true).catch(() => failed.push(path))
    }
  }
  if (failed.length) toast.add({ title: 'Some files are still in Dropbox', description: `Delete them by hand: ${failed.join(', ')}`, color: 'warning', icon: 'i-lucide-cloud-alert', duration: 0 })
}
async function undoLatest() {
  const batch = latest.value
  if (!batch || !(await confirmDialog({
    title: `Undo ${batch.code}?`,
    description: `${batch.code}, its scores and reviews are deleted, and its ${batch.size} static ad${batch.size === 1 ? '' : 's'} can be batched again. Its batch files and renders/${batch.code}/ folder go to Dropbox's deleted files.`,
    confirmLabel: `Undo ${batch.code}`,
    danger: true
  }))) return
  undoing.value = true
  const ok = await run(async () => {
    const code = must(await db.rpc('undo_batch', { p_shoot_id: shoot.value.id, p_medium: 'static' })) as string
    await removeFiles([code])
  }, `${batch.code} undone`)
  undoing.value = false
  if (ok) {
    await loop.load()
    emit('changed')
  }
}
async function resetAll() {
  if (!batches.value.length || !(await confirmDialog({
    title: `Reset all ${batches.value.length} static batches?`,
    description: `${batches.value.map(batch => batch.code).join(', ')}, their scores and reviews are deleted, so static batching starts again from SB01. Video batches aren't touched.`,
    confirmLabel: 'Reset static batches',
    danger: true
  }))) return
  undoing.value = true
  const ok = await run(async () => {
    const codes = must(await db.rpc('reset_batches', { p_shoot_id: shoot.value.id, p_medium: 'static' })) as string[]
    await removeFiles(codes)
  }, 'Static batches reset: start again from SB01')
  undoing.value = false
  if (ok) {
    await loop.load()
    emit('changed')
  }
}

// --- measuring ----------------------------------------------------------------------------
type StaticElement = { kind: StaticElementKind, key: string }
const id = (element: StaticElement) => `${element.kind}:${element.key}`
const measuring = ref<BatchRow | null>(null)
const measureElements = computed(() => measuring.value ? staticBatchElements(loop.batchRecipes(measuring.value)) : [])
const measureScores = computed(() => measuring.value ? loop.scoresOf(measuring.value) : new Map<string, Score>())
const unscored = computed(() => measureElements.value.filter(element => !measureScores.value.has(id(element))).length)
const grouped = (elements: StaticElement[]) => STATIC_ELEMENT_KINDS
  .map(kind => ({ kind, elements: elements.filter(element => element.kind === kind) }))
  .filter(group => group.elements.length)
async function score(element: StaticElement, value: Score) {
  if (!measuring.value) return
  const next = measureScores.value.get(id(element)) === value ? null : value
  await run(() => loop.setScore(measuring.value!, element.kind, element.key, next))
}
const savingMeasure = ref(false)
async function markMeasured() {
  if (!measuring.value || unscored.value) return
  savingMeasure.value = true
  const ok = await run(() => loop.setStatus(measuring.value!, 'measured'), `${measuring.value.code} measured: the next static batch is open`)
  savingMeasure.value = false
  if (ok) measuring.value = null
}

// --- every element ------------------------------------------------------------------------
const elementsOpen = ref(false)
const allElements = computed(() => staticBatchElements(recipes.value))
const stateOf = (element: StaticElement) => elementState(records.value.get(id(element)))
const STATE_BADGE = {
  winner: { label: 'Winner', color: 'success' },
  tried: { label: 'Tried', color: 'neutral' },
  untried: { label: 'Untried', color: 'info' },
  dropped: { label: 'Dropped', color: 'error' }
} as const
async function toggleDrop(element: StaticElement) {
  const record = records.value.get(id(element))
  const dropped = stateOf(element) === 'dropped'
  const auto = !!record && record.losers >= DROP_AFTER_LOSSES && record.winners === 0
  await run(() => loop.setDropped(element.kind, element.key, auto === !dropped ? null : !dropped))
}
const planStatic = computed(() => loop.manifest.value?.plan.static ?? null)
function describe(element: StaticElement): { title: string, detail: string } {
  switch (element.kind) {
    case 'static_format': return { title: element.key, detail: planStatic.value?.formats.find(format => format.code === element.key)?.name ?? '' }
    case 'variant': return { title: STATIC_VARIANT_LABELS[element.key as StaticVariant] ?? element.key, detail: '' }
    case 'static_copy': {
      const code = element.key.split('.')[0]!
      const copy = planStatic.value?.copies.find(entry => entry.code === code)
      return { title: element.key, detail: copy?.slots[0]?.text ?? '' }
    }
    case 'avatar': return { title: loop.manifest.value?.plan.people.find(person => person.slug === element.key)?.name ?? element.key, detail: '' }
  }
}
const tally = (element: StaticElement) => {
  const record = records.value.get(id(element))
  return record ? `${record.winners}W · ${record.mids}M · ${record.losers}L` : ''
}
const KIND_ICONS: Record<StaticElementKind, string> = {
  static_format: 'i-lucide-image', variant: 'i-lucide-shapes', static_copy: 'i-lucide-type', avatar: 'i-lucide-user'
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const NEXT: Partial<Record<BatchStatus, { status: BatchStatus, label: string, icon: string }>> = {
  batched: { status: 'rendering', label: 'Rendering', icon: 'i-lucide-paintbrush' },
  rendering: { status: 'submitted', label: 'Submitted', icon: 'i-lucide-send' }
}
</script>

<template>
  <div class="space-y-4">
    <UCard :ui="{ body: 'space-y-3' }">
      <div class="flex flex-wrap items-start gap-3">
        <UIcon name="i-lucide-image" class="mt-0.5 size-6 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <p class="font-medium text-highlighted">
            Next static batch: {{ nextCode }}
          </p>
          <p v-if="!recipes.length" class="text-sm text-muted">
            {{ loop.loading.value ? 'Loading the static ads…' : 'No static ads: the Live manifest made none.' }}
          </p>
          <p v-else-if="!canBatch" class="text-sm text-muted">
            Measure {{ waitingOn.join(', ') }} first.
          </p>
          <p v-else class="text-sm text-muted">
            {{ formatNumber(preview.recipes.length) }} ads ({{ sizePct }}% of {{ formatNumber(recipes.length) }}):
            <template v-if="preview.exploit">
              {{ formatNumber(preview.exploit) }} exploit winners, {{ formatNumber(preview.explore) }} explore.
            </template>
            <template v-else>
              all exploring, until something wins.
            </template>
            <template v-if="preview.dropped">
              {{ formatNumber(preview.dropped) }} left out for a dropped element.
            </template>
          </p>
        </div>
        <UButton
          v-if="isAdmin"
          :label="`Make ${nextCode}`"
          icon="i-lucide-sparkles"
          size="sm"
          :loading="generating"
          :disabled="!canBatch || !preview.recipes.length"
          @click="generate"
        />
      </div>
      <div v-if="recipes.length" class="space-y-1">
        <UProgress :model-value="usedPct" size="sm" />
        <p class="text-xs text-muted">
          {{ usedPct }}% of the static ads batched
        </p>
      </div>
      <div v-if="isAdmin" class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-muted">Static batch size</span>
        <UInput v-model.number="sizePct" type="number" min="0.5" max="100" step="0.5" class="w-24" size="sm" @change="saveSize">
          <template #trailing>
            <span class="text-xs text-muted">%</span>
          </template>
        </UInput>
        <span class="text-muted">· {{ formatNumber(size) }} of {{ formatNumber(recipes.length) }} ads</span>
      </div>
    </UCard>

    <ul v-if="batches.length" class="divide-y divide-default rounded-lg border border-default text-sm">
      <li v-for="batch in [...batches].reverse()" :key="batch.code" class="flex flex-wrap items-center gap-2 px-3 py-2">
        <span class="font-mono font-semibold text-highlighted">{{ batch.code }}</span>
        <UBadge :label="BATCH_STATUS_LABELS[batch.status]" :color="BATCH_STATUS_COLORS[batch.status]" variant="subtle" size="sm" />
        <span class="text-muted">{{ batch.size }} ad{{ batch.size === 1 ? '' : 's' }}</span>
        <span class="ml-auto text-xs text-muted">{{ BATCH_STATUS_LABELS[batch.status] }} {{ when(batch.status_at) }}</span>
        <UButton
          v-if="batch.status !== 'batched'"
          label="Review"
          icon="i-lucide-images"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="openReview(batch)"
        />
        <UButton
          v-if="isAdmin && NEXT[batch.status]"
          :label="`Mark ${NEXT[batch.status]!.label.toLowerCase()}`"
          :icon="NEXT[batch.status]!.icon"
          size="xs"
          color="neutral"
          variant="subtle"
          @click="advance(batch, NEXT[batch.status]!.status)"
        />
        <UButton
          v-else-if="isAdmin"
          :label="batch.status === 'measured' ? 'Scores' : 'Measure'"
          icon="i-lucide-gauge"
          size="xs"
          :color="batch.status === 'measured' ? 'neutral' : 'primary'"
          :variant="batch.status === 'measured' ? 'ghost' : 'solid'"
          @click="measuring = batch"
        />
        <UButton v-if="isAdmin && batch.id === latest?.id" label="Undo" icon="i-lucide-undo-2" size="xs" color="error" variant="ghost" :loading="undoing" @click="undoLatest" />
      </li>
      <li v-if="isAdmin && batches.length > 1" class="flex justify-end px-3 py-2">
        <UButton label="Reset static batches" icon="i-lucide-rotate-ccw" size="xs" color="error" variant="ghost" :loading="undoing" @click="resetAll" />
      </li>
    </ul>

    <UCard :ui="{ body: elementsOpen ? 'space-y-4' : 'hidden' }">
      <template #header>
        <button type="button" class="flex w-full items-center gap-2 text-left" :aria-expanded="elementsOpen" @click="elementsOpen = !elementsOpen">
          <UIcon name="i-lucide-chevron-right" class="size-4 text-muted transition-transform" :class="{ 'rotate-90': elementsOpen }" />
          <h2 class="flex-1 font-semibold text-highlighted">
            Static elements
          </h2>
        </button>
      </template>
      <div v-for="group in grouped(allElements)" :key="group.kind" class="space-y-1">
        <p class="flex items-center gap-1.5 text-xs font-medium text-muted uppercase">
          <UIcon :name="KIND_ICONS[group.kind]" class="size-3.5" />
          {{ STATIC_ELEMENT_LABELS[group.kind] }}
        </p>
        <div v-for="element in group.elements" :key="id(element)" class="flex items-center gap-2 text-sm">
          <span class="w-28 shrink-0 truncate font-medium text-highlighted">{{ describe(element).title }}</span>
          <span class="min-w-0 flex-1 truncate text-muted">{{ describe(element).detail }}</span>
          <span class="text-xs text-dimmed tabular-nums">{{ tally(element) }}</span>
          <UBadge :label="STATE_BADGE[stateOf(element)].label" :color="STATE_BADGE[stateOf(element)].color" variant="subtle" size="sm" />
          <UButton
            v-if="isAdmin"
            :label="stateOf(element) === 'dropped' ? 'Keep' : 'Drop'"
            size="xs"
            :color="stateOf(element) === 'dropped' ? 'neutral' : 'error'"
            variant="ghost"
            @click="toggleDrop(element)"
          />
        </div>
      </div>
    </UCard>

    <!-- reviewing a batch's renders, from Kanvas's index -->
    <UModal :open="!!reviewing" :title="reviewing ? `Review ${reviewing.code}` : ''" :ui="{ content: 'max-w-3xl' }" @update:open="open => { if (!open) reviewing = null }">
      <template #body>
        <div class="space-y-3">
          <p v-if="reading" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> Reading Kanvas's index…
          </p>
          <UAlert v-else-if="loop.kanvasError.value" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="loop.kanvasError.value" />
          <UAlert v-if="planHashChanged" color="warning" variant="subtle" icon="i-lucide-triangle-alert" description="Kanvas worked from a different plan than the Live one: the shoot changed after it ran." />
          <ul class="divide-y divide-default rounded-lg border border-default">
            <li v-for="recipe in reviewRecipes" :key="recipe.id" class="space-y-1.5 px-3 py-2 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs text-highlighted">{{ recipe.id }}</span>
                <UBadge v-if="!renderOf(recipe)" label="Not rendered yet" color="neutral" variant="subtle" size="sm" />
                <UBadge v-else-if="renderOf(recipe)!.status === 'failed'" label="Failed" color="error" variant="subtle" size="sm" />
                <UBadge v-if="reviewing && loop.reviewOf(reviewing, recipe.id)" :label="loop.reviewOf(reviewing, recipe.id) === 'approved' ? 'Approved' : 'Rejected: left out'" :color="loop.reviewOf(reviewing, recipe.id) === 'approved' ? 'success' : 'error'" variant="subtle" size="sm" />
              </div>
              <p class="text-muted">
                {{ Object.values(recipe.copy.slots).join(' · ') }}
              </p>
              <div v-if="renderOf(recipe)" class="flex flex-wrap items-center gap-1.5">
                <template v-for="(file, sizeName) in renderOf(recipe)!.files" :key="sizeName">
                  <UButton
                    v-if="file"
                    :label="String(sizeName).replace('x', ':')"
                    icon="i-lucide-external-link"
                    size="xs"
                    color="neutral"
                    variant="subtle"
                    :loading="opening === file"
                    @click="view(file)"
                  />
                </template>
                <UBadge
                  v-for="(flag, index) in renderOf(recipe)!.flags"
                  :key="index"
                  :label="`${KANVAS_FLAG_LABELS[flag.code]}${flag.size ? ` (${flag.size})` : ''}`"
                  :color="BLOCKING_FLAGS.includes(flag.code) ? 'warning' : 'neutral'"
                  variant="subtle"
                  size="sm"
                  :title="flag.note"
                />
              </div>
              <div v-if="isAdmin && renderOf(recipe) && blockingFlags(renderOf(recipe)!).length" class="flex gap-1.5">
                <UButton label="Approve" size="xs" :color="reviewing && loop.reviewOf(reviewing, recipe.id) === 'approved' ? 'success' : 'neutral'" :variant="reviewing && loop.reviewOf(reviewing, recipe.id) === 'approved' ? 'solid' : 'subtle'" @click="decide(recipe, 'approved')" />
                <UButton label="Reject" size="xs" :color="reviewing && loop.reviewOf(reviewing, recipe.id) === 'rejected' ? 'error' : 'neutral'" :variant="reviewing && loop.reviewOf(reviewing, recipe.id) === 'rejected' ? 'solid' : 'subtle'" @click="decide(recipe, 'rejected')" />
              </div>
            </li>
          </ul>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-end gap-2">
          <span v-if="reviewing && loop.undecided(reviewing).length" class="mr-auto text-xs text-warning">
            {{ loop.undecided(reviewing).length }} to approve or reject before it's submitted
          </span>
          <UButton label="Close" color="neutral" variant="ghost" @click="reviewing = null" />
        </div>
      </template>
    </UModal>

    <!-- measuring a static batch -->
    <UModal :open="!!measuring" :title="measuring ? `Measure ${measuring.code}` : ''" :ui="{ content: 'max-w-2xl' }" @update:open="open => { if (!open) measuring = null }">
      <template #body>
        <div class="space-y-4">
          <ul class="space-y-1 rounded-lg bg-elevated/50 p-3 text-sm">
            <li v-for="value in SCORES" :key="value">
              <span class="font-medium">{{ SCORE_GUIDE[value].label }}:</span>
              <span class="text-muted"> {{ SCORE_GUIDE[value].rule }}</span>
            </li>
          </ul>
          <div v-for="group in grouped(measureElements)" :key="group.kind" class="space-y-1">
            <p class="flex items-center gap-1.5 text-xs font-medium text-muted uppercase">
              <UIcon :name="KIND_ICONS[group.kind]" class="size-3.5" />
              {{ STATIC_ELEMENT_LABELS[group.kind] }}
            </p>
            <div v-for="element in group.elements" :key="id(element)" class="flex items-center gap-2 text-sm">
              <span class="w-28 shrink-0 truncate font-medium text-highlighted">{{ describe(element).title }}</span>
              <span class="min-w-0 flex-1 truncate text-muted">{{ describe(element).detail }}</span>
              <div class="flex shrink-0 gap-1">
                <UButton
                  v-for="value in SCORES"
                  :key="value"
                  :label="SCORE_GUIDE[value].label"
                  size="xs"
                  :color="measureScores.get(id(element)) === value ? (value === 'winner' ? 'success' : value === 'loser' ? 'error' : 'neutral') : 'neutral'"
                  :variant="measureScores.get(id(element)) === value ? 'solid' : 'ghost'"
                  @click="score(element, value)"
                />
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap items-center justify-end gap-2">
          <span v-if="measuring?.status !== 'measured'" class="mr-auto text-xs text-muted">
            {{ unscored ? `${unscored} element${unscored === 1 ? '' : 's'} still to score` : 'Every element scored' }}
          </span>
          <UButton label="Close" color="neutral" variant="ghost" @click="measuring = null" />
          <UButton v-if="measuring?.status !== 'measured'" label="Mark measured" icon="i-lucide-gauge" :disabled="unscored > 0" :loading="savingMeasure" @click="markMeasured" />
        </div>
      </template>
    </UModal>
  </div>
</template>
