<script setup lang="ts">
import type { Row } from '#shared/types/models'
import type { LoadedShoot } from '#shared/utils/loadShoot'
import type { CopySlot, StillKind } from '#shared/utils/statics'

// A shoot's static ads (docs/spec-statics.md §4, §5): the static formats it uses, the copy written
// for each (A01, A02…, for its product, with other wordings), and the stills to take on set for
// product and avatar variants. Everything changes while the shoot is a draft, through
// shared/utils/staticPlan.ts (as the AI connector does); once planned it's frozen.
const props = defineProps<{ bundle: LoadedShoot, draft: boolean, live: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const db = useDb()
const run = useAction()
const { isAdmin, access } = useAccess()
const { featureOptions } = useRefData()
const statics = computed(() => props.bundle.statics ?? { formats: [], copies: [], stills: [] })
const features = computed(() => featureOptions(props.bundle.product.id))
const editable = computed(() => props.draft && isAdmin.value)

// --- the shoot's static formats --------------------------------------------------------------
const library = shallowRef<Row<'static_formats'>[]>([])
run(async () => {
  const rows = await db.from('static_formats').select('*').eq('archived', false).order('code')
  library.value = (must(rows) ?? []) as Row<'static_formats'>[]
})
const addable = computed(() => library.value
  .filter(format => !statics.value.formats.some(entry => entry.id === format.id))
  .map(format => ({ label: `${format.code} · ${format.name}`, value: format.id, description: format.variants.map(v => STATIC_VARIANT_LABELS[v as StaticVariant] ?? v).join(', ') })))
const picked = ref<string[]>([])
async function addFormats() {
  const ids = picked.value
  if (!ids.length) return
  const ok = await run(async () => {
    const added = await addShootStaticFormats(db, props.bundle, ids)
    return added
  }, `Added ${ids.length} static format${ids.length === 1 ? '' : 's'}`)
  if (ok) {
    picked.value = []
    emit('changed')
  }
}
const { confirmDialog } = useConfirm()
async function removeFormat(format: Row<'static_formats'>) {
  const copies = copiesOf(format.id).length
  if (!(await confirmDialog({
    title: `Take ${format.code} off the shoot?`,
    description: copies ? `Its ${copies} cop${copies === 1 ? 'y goes' : 'ies go'} too.` : 'It has no copy yet.',
    confirmLabel: 'Take it off',
    danger: copies > 0
  }))) return
  if (await run(() => removeShootStaticFormat(db, props.bundle, format.id), `${format.code} taken off`)) emit('changed')
}

// --- copy ---------------------------------------------------------------------------------------
const copiesOf = (formatId: string) => statics.value.copies.filter(copy => copy.static_format_id === formatId)
const slotsOf = (format: Row<'static_formats'>) => parseStaticSlots(format.slots)

/** the copy being edited, by id ('new:<format id>' for a new one) */
const editing = ref<string | null>(null)
const draftCopy = reactive({
  formatId: '',
  slots: [] as { slot: string, text: string, alternates: string[] }[],
  feature_id: null as string | null,
  cast_channel_id: null as string | null,
  notes: ''
})
function startCopy(format: Row<'static_formats'>, copy?: Row<'static_copies'>) {
  const given = parseCopySlots(copy?.slots)
  Object.assign(draftCopy, {
    formatId: format.id,
    slots: slotsOf(format).map((slot) => {
      const entry = given.find(item => item.slot === slot.key)
      return { slot: slot.key, text: entry?.text ?? '', alternates: entry?.alternates.map(alt => alt.text) ?? [] }
    }),
    feature_id: copy?.feature_id ?? null,
    cast_channel_id: copy?.cast_channel_id ?? null,
    notes: copy?.notes ?? ''
  })
  editing.value = copy?.id ?? `new:${format.id}`
}
const copyProblem = computed(() => {
  const format = statics.value.formats.find(entry => entry.id === draftCopy.formatId)
  if (!format) return null
  try {
    cleanCopySlots(slotsOf(format), draftCopy.slots)
    return null
  } catch (error) {
    return (error as Error).message
  }
})
const savingCopy = ref(false)
async function saveCopy() {
  savingCopy.value = true
  const id = editing.value?.startsWith('new:') ? undefined : editing.value ?? undefined
  const existing = id ? statics.value.copies.find(copy => copy.id === id) : undefined
  const ok = await run(() => saveStaticCopy(db, props.bundle, {
    static_format_id: draftCopy.formatId,
    slots: draftCopy.slots,
    feature_id: draftCopy.feature_id,
    cast_channel_id: draftCopy.cast_channel_id,
    notes: draftCopy.notes,
    // written or saved by a person: no longer an AI draft
    tags: (existing?.tags ?? []).filter(tag => tag !== AI_DRAFT_TAG),
    ...(id ? {} : { person_id: props.bundle.people.find(person => person.user_id && person.user_id === access.value?.id)?.id ?? null })
  }, id), 'Copy saved')
  savingCopy.value = false
  if (ok) {
    editing.value = null
    emit('changed')
  }
}
async function removeCopy(copy: Row<'static_copies'>) {
  if (!(await confirmDialog({ title: `Delete ${copy.code}?`, confirmLabel: 'Delete', danger: true }))) return
  if (await run(() => removeStaticCopy(db, props.bundle, copy.id), `${copy.code} deleted`)) emit('changed')
}
const slotLabel = (format: Row<'static_formats'>, key: string) => slotsOf(format).find(slot => slot.key === key)?.label ?? key
const slotOf = (format: Row<'static_formats'>, key: string) => slotsOf(format).find(slot => slot.key === key)

/** each channel a copy is for, with its copy filled for that channel (only when slots make them differ) */
function filled(copy: Row<'static_copies'>) {
  const slots = parseCopySlots(copy.slots)
  return copyChannels(props.bundle.channels, copy).map(channel => ({ channel: channel.name, ...renderCopy(slots, copyContext(props.bundle, channel)) }))
}
const differsByChannel = (copy: Row<'static_copies'>) => new Set(filled(copy).map(entry => JSON.stringify(entry.slots))).size > 1
const channelItems = computed(() => [{ label: 'Every channel', value: null }, ...props.bundle.channels.map(channel => ({ label: channel.name, value: channel.id }))])
const featureItems = computed(() => [{ label: 'No feature', value: null }, ...features.value])
const wordings = (slots: CopySlot[]) => copyCombinations(slots)

// --- stills -------------------------------------------------------------------------------------
const needs = computed(() => stillsNeeded(statics.value.formats.flatMap(format => format.variants)))
const stillsOf = (kind: StillKind) => statics.value.stills.filter(still => still.kind === kind)
const newStill = reactive({ kind: 'product' as StillKind, description: '', feature_id: null as string | null, count: 3 })
async function addStill(kind: StillKind) {
  if (!newStill.description.trim()) return
  const ok = await run(() => addStillShots(db, props.bundle, [{ kind, description: newStill.description, feature_id: newStill.feature_id, count: newStill.count }]))
  if (ok) {
    Object.assign(newStill, { description: '', feature_id: null, count: 3 })
    emit('changed')
  }
}
async function changeStill(still: Row<'still_shots'>, patch: { description?: string, count?: number, feature_id?: string | null }) {
  if (await run(() => updateStillShot(db, props.bundle, still.id, patch))) emit('changed')
}
async function removeStill(still: Row<'still_shots'>) {
  if (await run(() => removeStillShots(db, props.bundle, [still.id]))) emit('changed')
}
const STILL_HELP: Record<StillKind, string> = {
  product: 'Photos of the product, on each channel: for the formats\' product variants.',
  avatar: 'Photos of each person: for the formats\' person variants. A frame from a filmed hook or CTA works too.'
}

// --- static settings ----------------------------------------------------------------------------
const settingsForm = reactive({ wording: props.bundle.shoot.static_wording_variations, batch: Math.round(Number(props.bundle.shoot.static_submission_rate) * 1000) / 10 })
watch(() => props.bundle.shoot, (shoot) => {
  settingsForm.wording = shoot.static_wording_variations
  settingsForm.batch = Math.round(Number(shoot.static_submission_rate) * 1000) / 10
})
async function saveSettings() {
  const ok = await run(async () => {
    must(await db.from('shoots').update({
      static_wording_variations: Math.max(0, Math.round(settingsForm.wording)),
      static_submission_rate: Math.min(100, Math.max(0, settingsForm.batch)) / 100
    }).eq('id', props.bundle.shoot.id))
  }, 'Static settings saved')
  if (ok) emit('changed')
}
const settingsChanged = computed(() => settingsForm.wording !== props.bundle.shoot.static_wording_variations
  || settingsForm.batch !== Math.round(Number(props.bundle.shoot.static_submission_rate) * 1000) / 10)
</script>

<template>
  <div class="space-y-6">
    <!-- formats on the shoot -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold text-highlighted">
              Static formats
            </h2>
            <p class="text-sm text-muted">
              Static ads for {{ bundle.product.name }}: copy for each format, made by Kanvas in each variant it has the ingredients for.
            </p>
          </div>
          <template v-if="editable">
            <USelectMenu
              v-model="picked"
              :items="addable"
              value-key="value"
              multiple
              placeholder="Add static formats"
              :search-input="{ placeholder: 'Search the Library' }"
              class="w-60"
            />
            <UButton label="Add" icon="i-lucide-plus" :disabled="!picked.length" @click="addFormats" />
          </template>
        </div>
      </template>

      <p v-if="!statics.formats.length" class="py-4 text-center text-sm text-muted">
        No static formats on this shoot.
        <template v-if="editable && !library.length">
          Make some in <NuxtLink to="/library?tab=statics" class="text-primary">Library → Statics</NuxtLink> first.
        </template>
      </p>

      <div class="-my-2 divide-y divide-default">
        <section v-for="format in statics.formats" :key="format.id" class="space-y-3 py-4">
          <div class="flex flex-wrap items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="text-highlighted">
                <span class="mr-2 font-mono font-semibold">{{ format.code }}</span>
                <span class="font-medium">{{ format.name }}</span>
              </p>
              <p v-if="format.description" class="text-sm text-muted">
                {{ format.description }}
              </p>
              <div class="mt-1 flex flex-wrap gap-1">
                <UBadge v-for="value in format.variants" :key="value" :label="STATIC_VARIANT_LABELS[value as StaticVariant] ?? value" color="neutral" variant="subtle" size="sm" />
              </div>
            </div>
            <UButton v-if="editable" label="Write copy" icon="i-lucide-pen-line" size="sm" color="neutral" variant="subtle" @click="startCopy(format)" />
            <UButton v-if="editable" icon="i-lucide-x" size="sm" color="neutral" variant="ghost" :aria-label="`Take ${format.code} off`" @click="removeFormat(format)" />
          </div>
          <p v-if="!slotsOf(format).length" class="text-xs text-warning">
            This format has no copy slots yet: give it some in Library → Statics.
          </p>

          <!-- its copy (the one being edited shows in the editor below) -->
          <div v-for="copy in copiesOf(format.id).filter(entry => entry.id !== editing)" :key="copy.id" class="rounded-lg border border-default p-3">
            <template v-if="copy">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono font-semibold text-highlighted">{{ copy.code }}</span>
                <UBadge v-if="copy.tags.includes(AI_DRAFT_TAG)" label="AI draft" icon="i-lucide-sparkles" color="primary" variant="subtle" size="sm" />
                <UBadge v-if="copy.cast_channel_id" :label="bundle.channels.find(channel => channel.id === copy.cast_channel_id)?.name ?? 'One channel'" color="neutral" variant="outline" size="sm" />
                <UBadge v-if="copy.feature_id" :label="features.find(feature => feature.value === copy.feature_id)?.label ?? 'A feature'" color="neutral" variant="outline" size="sm" />
                <span v-if="wordings(parseCopySlots(copy.slots)) > 1" class="text-xs text-muted">{{ wordings(parseCopySlots(copy.slots)) }} wordings</span>
                <div class="ml-auto flex">
                  <UButton v-if="editable" icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" :aria-label="`Edit ${copy.code}`" @click="startCopy(format, copy)" />
                  <UButton v-if="editable" icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" :aria-label="`Delete ${copy.code}`" @click="removeCopy(copy)" />
                </div>
              </div>
              <dl class="mt-2 space-y-1.5 text-sm">
                <div v-for="slot in parseCopySlots(copy.slots)" :key="slot.slot">
                  <dt class="text-xs font-medium text-muted">
                    {{ slotLabel(format, slot.slot) }}
                  </dt>
                  <dd class="text-highlighted">
                    {{ slot.text }}
                    <span v-if="slotOf(format, slot.slot) && slotOverLimit(slotOf(format, slot.slot)!, slot.text)" class="ml-1 text-xs text-warning">{{ slotOverLimit(slotOf(format, slot.slot)!, slot.text) }}</span>
                  </dd>
                  <dd v-for="(alt, index) in slot.alternates" :key="index" class="text-muted">
                    <span class="mr-1 text-xs">[{{ index + 2 }}]</span>{{ alt.text }}
                  </dd>
                </div>
              </dl>
              <!-- filled per channel, where the channel's slots make it differ -->
              <div v-if="differsByChannel(copy)" class="mt-2 space-y-1 border-t border-default pt-2 text-xs text-muted">
                <p v-for="entry in filled(copy)" :key="entry.channel">
                  <span class="font-medium text-default">{{ entry.channel }}:</span>
                  {{ entry.slots.map(slot => slot.text).join(' · ') }}
                </p>
              </div>
              <p v-for="entry in filled(copy).filter(item => item.unfilled.length)" :key="`u-${entry.channel}`" class="mt-1 text-xs text-warning">
                {{ entry.channel }}: fill {{ entry.unfilled.map(slot => `{{${slot}}}`).join(', ') }}
              </p>
            </template>
          </div>

          <!-- writing or changing a copy -->
          <div v-if="editing && draftCopy.formatId === format.id" class="space-y-3 rounded-lg border border-primary/40 p-3">
            <p class="text-sm font-semibold text-highlighted">
              {{ editing.startsWith('new:') ? `New copy for ${format.code}` : statics.copies.find(copy => copy.id === editing)?.code }}
            </p>
            <div v-for="slot in draftCopy.slots" :key="slot.slot" class="space-y-1.5">
              <UFormField
                :label="slotLabel(format, slot.slot)"
                :required="slotOf(format, slot.slot)?.required"
                :help="[slotOf(format, slot.slot)?.guidance, slotOf(format, slot.slot)?.max_words ? `Up to ${slotOf(format, slot.slot)!.max_words} words` : null].filter(Boolean).join(' · ') || undefined"
                :hint="slotOf(format, slot.slot) && slot.text ? slotOverLimit(slotOf(format, slot.slot)!, slot.text) ?? undefined : undefined"
              >
                <UTextarea v-model="slot.text" autoresize :rows="1" :placeholder="slotOf(format, slot.slot)?.example ?? ''" class="w-full" />
              </UFormField>
              <div v-for="(_alt, index) in slot.alternates" :key="index" class="flex items-start gap-2 pl-4">
                <span class="mt-2 text-xs text-muted">[{{ index + 2 }}]</span>
                <UTextarea v-model="slot.alternates[index]" autoresize :rows="1" class="min-w-0 flex-1" :aria-label="`${slotLabel(format, slot.slot)}, wording ${index + 2}`" />
                <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove this wording" @click="slot.alternates.splice(index, 1)" />
              </div>
              <UButton label="Add a wording" icon="i-lucide-plus" size="xs" color="neutral" variant="link" class="pl-4" @click="slot.alternates.push('')" />
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField label="For">
                <USelect v-model="draftCopy.cast_channel_id" :items="channelItems" class="w-full" />
              </UFormField>
              <UFormField v-if="features.length" label="About a feature">
                <USelect v-model="draftCopy.feature_id" :items="featureItems" class="w-full" />
              </UFormField>
            </div>
            <UFormField label="Notes">
              <UTextarea v-model="draftCopy.notes" autoresize :rows="1" class="w-full" />
            </UFormField>
            <p class="text-xs text-muted">
              <span v-pre>{{brand}}, {{product}}</span>, channel slots and this shoot's custom slots are filled in for each channel.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <UButton label="Save copy" :loading="savingCopy" :disabled="!!copyProblem" @click="saveCopy" />
              <UButton label="Cancel" color="neutral" variant="ghost" @click="editing = null" />
              <span v-if="copyProblem" class="text-xs text-error">{{ copyProblem }}</span>
            </div>
          </div>
        </section>
      </div>
    </UCard>

    <!-- stills -->
    <UCard v-if="statics.formats.length || statics.stills.length">
      <template #header>
        <h2 class="font-semibold text-highlighted">
          Stills
        </h2>
        <p class="text-sm text-muted">
          Photos taken on set for the product and person variants. They're on the checklist after the b-roll.
        </p>
      </template>
      <div class="space-y-5">
        <div v-for="kind in STILL_KINDS" :key="kind" class="space-y-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-highlighted">
              {{ kind === 'product' ? 'Product stills' : 'Avatar stills' }}
            </h3>
            <UBadge v-if="needs[kind] && !stillsOf(kind).length" label="Needed" color="warning" variant="subtle" size="sm" />
          </div>
          <p class="text-xs text-muted">
            {{ STILL_HELP[kind] }}
          </p>
          <div v-for="still in stillsOf(kind)" :key="still.id" class="flex flex-wrap items-center gap-2">
            <UInput
              :model-value="still.description"
              :disabled="!isAdmin"
              class="min-w-0 flex-1"
              :aria-label="`Still: ${still.description}`"
              @change="changeStill(still, { description: ($event.target as HTMLInputElement).value })"
            />
            <USelect
              v-if="kind === 'product' && features.length"
              :model-value="still.feature_id"
              :items="featureItems"
              :disabled="!editable"
              class="w-44"
              aria-label="Feature"
              @update:model-value="changeStill(still, { feature_id: $event as string | null })"
            />
            <UInputNumber
              :model-value="still.count"
              :min="1"
              :max="20"
              :disabled="!isAdmin"
              class="w-28"
              :aria-label="kind === 'product' ? 'Photos per channel' : 'Photos per person'"
              @update:model-value="changeStill(still, { count: Number($event) })"
            />
            <span class="text-xs text-muted">per {{ kind === 'product' ? 'channel' : 'person' }}</span>
            <UButton v-if="editable" icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove still" @click="removeStill(still)" />
          </div>
          <div v-if="editable" class="flex flex-wrap items-center gap-2">
            <UInput
              :model-value="newStill.kind === kind ? newStill.description : ''"
              :placeholder="kind === 'product' ? 'Another product still' : 'Another avatar still'"
              class="min-w-0 flex-1"
              @update:model-value="newStill.kind = kind; newStill.description = String($event)"
              @keydown.enter="addStill(kind)"
            />
            <UButton label="Add" icon="i-lucide-plus" size="sm" color="neutral" variant="subtle" :disabled="newStill.kind !== kind || !newStill.description.trim()" @click="addStill(kind)" />
          </div>
        </div>
      </div>
    </UCard>

    <!-- static settings -->
    <UCard v-if="statics.formats.length">
      <template #header>
        <h2 class="font-semibold text-highlighted">
          Static settings
        </h2>
      </template>
      <fieldset :disabled="!isAdmin || live" class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Wording mixes" help="Extra static ads per copy from mixing its slots' other wordings (0 = first wordings only)">
          <UInputNumber v-model="settingsForm.wording" :min="0" :max="50" class="w-full" />
        </UFormField>
        <UFormField label="Static batch size (%)" help="Share of the shoot's static ads each static batch submits">
          <UInputNumber v-model="settingsForm.batch" :min="0" :max="100" :step="0.5" class="w-full" />
        </UFormField>
      </fieldset>
      <template v-if="isAdmin && !live" #footer>
        <UButton label="Save static settings" size="sm" :disabled="!settingsChanged" @click="saveSettings" />
      </template>
    </UCard>
  </div>
</template>
