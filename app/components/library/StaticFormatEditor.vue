<script setup lang="ts">
import type { Row } from '#shared/types/models'
import type { StaticReference, StaticSlot } from '#shared/utils/statics'

// Slide-over editor for a static format (docs/spec-statics.md §2). Open it with `edit(row)`,
// `edit()` for a new one, `edit(row, true)` to start from a copy, or `fromExample(file)` to start
// from an example ad shown beside the fields, so the person can describe what they see.
// Saving through shared/utils/staticPlan.ts, as the AI connector does. Saving by a person takes
// the "ai-draft" tag off.
const emit = defineEmits<{ saved: [] }>()

const db = useDb()
const run = useAction()

const open = ref(false)
const saving = ref(false)
type SlotDraft = StaticSlot & { uid: number }
let uid = 0
const blankSlot = (): SlotDraft => ({ uid: ++uid, key: '', label: '', max_words: null, guidance: null, example: null, required: true })
const form = reactive({
  id: '',
  org_id: '',
  code: '',
  name: '',
  description: '',
  mechanism: '',
  slots: [] as SlotDraft[],
  variants: ['text'] as string[],
  always: '',
  never: '',
  references: [] as StaticReference[],
  /** example ads picked here, stored when the format is saved */
  pending: [] as { file: File, url: string, source_url: string }[],
  plate: false,
  text_render: 'ai',
  sizes: [...STATIC_SIZES] as string[],
  tags: [] as string[],
  notes: '',
  archived: false
})
const requestOpen = useGuardedClose(open, form)
const advancedOpen = ref(false)

/** signed links for stored references, path → link */
const links = ref<Record<string, string>>({})
async function loadLinks() {
  const paths = form.references.map(ref => ref.path).filter(path => !links.value[path])
  if (!paths.length) return
  links.value = { ...links.value, ...await signedStaticReferences(db, paths) }
}

function edit(row?: Row<'static_formats'>, duplicate = false) {
  const rules = parseStaticRules(row?.rules)
  for (const entry of form.pending) URL.revokeObjectURL(entry.url)
  Object.assign(form, {
    id: duplicate ? '' : row?.id ?? '',
    org_id: row?.org_id ?? '',
    code: duplicate ? '' : row?.code ?? '',
    name: row ? (duplicate ? `${row.name} (copy)` : row.name) : '',
    description: row?.description ?? '',
    mechanism: row?.mechanism ?? '',
    slots: parseStaticSlots(row?.slots).map(slot => ({ ...slot, uid: ++uid })),
    variants: [...(row?.variants ?? ['text'])],
    always: rules.always.join('\n'),
    never: rules.never.join('\n'),
    // a copy starts without the example ads: they're the original's files
    references: duplicate ? [] : parseStaticReferences(row?.reference_images),
    pending: [],
    plate: row?.plate ?? false,
    text_render: row?.text_render ?? 'ai',
    sizes: [...(row?.sizes ?? STATIC_SIZES)],
    tags: (row?.tags ?? []).filter(tag => !duplicate || tag !== AI_DRAFT_TAG),
    notes: row?.notes ?? '',
    archived: duplicate ? false : row?.archived ?? false
  })
  if (!form.slots.length) form.slots = [blankSlot()]
  advancedOpen.value = false
  open.value = true
  run(loadLinks)
}

/** a new format from an example ad: the ad beside an empty editor */
function fromExample(file: File) {
  edit()
  addFiles([file])
}
defineExpose({ edit, fromExample })

// --- references ----------------------------------------------------------------------------
const ACCEPT = Object.keys(STATIC_REFERENCE_TYPES).join(',')
const picker = useTemplateRef<HTMLInputElement>('picker')
const fileProblem = ref('')
function addFiles(files: File[]) {
  fileProblem.value = ''
  for (const file of files) {
    if (!STATIC_REFERENCE_TYPES[file.type]) fileProblem.value = `${file.name} isn't a PNG, JPG, WebP, GIF or PDF. Export a PSD, Figma or Canva design as one of those.`
    else if (file.size > MAX_STATIC_REFERENCE_BYTES) fileProblem.value = `${file.name} is over 20 MB.`
    else form.pending.push({ file, url: URL.createObjectURL(file), source_url: '' })
  }
}
function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles([...(input.files ?? [])])
  input.value = ''
}
function moveReference(index: number, by: number) {
  const next = [...form.references]
  const [moved] = next.splice(index, 1)
  next.splice(index + by, 0, moved!)
  form.references = next
}
const isPdf = (path: string) => path.toLowerCase().endsWith('.pdf')
/** what to show beside the fields: the first example ad, stored or just picked */
const preview = computed(() => {
  const stored = form.references[0]
  if (stored) return { url: links.value[stored.path], pdf: isPdf(stored.path) }
  const picked = form.pending[0]
  return picked ? { url: picked.url, pdf: picked.file.type === 'application/pdf' } : null
})

// --- slots ---------------------------------------------------------------------------------
function moveSlot(index: number, by: number) {
  const next = [...form.slots]
  const [moved] = next.splice(index, 1)
  next.splice(index + by, 0, moved!)
  form.slots = next
}
const slotProblem = computed(() => {
  try {
    cleanStaticSlots(form.slots)
    return null
  } catch (error) {
    return (error as Error).message
  }
})

const variantItems = STATIC_VARIANTS.map(value => ({ value, label: STATIC_VARIANT_LABELS[value] }))
const VARIANT_HELP: Record<string, string> = {
  text: 'Copy only',
  text_product: 'Copy and the product: a product still, a packshot, or drawn by Kanvas (flagged for approval)',
  text_avatar: 'Copy and a person: their avatar still, or a frame from a hook or CTA they filmed',
  text_product_avatar: 'Copy, the product and a person'
}
function toggle(list: 'variants' | 'sizes', value: string, on: boolean) {
  form[list] = on ? [...new Set([...form[list], value])] : form[list].filter(entry => entry !== value)
}
const textRenders = [
  { label: 'The image AI writes the copy', value: 'ai' },
  { label: 'Set in type over the image', value: 'overlay' }
]

const canSave = computed(() => !!form.name.trim() && form.variants.length > 0 && form.sizes.length > 0 && !slotProblem.value)
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean)

async function save() {
  saving.value = true
  const ok = await run(async () => {
    const row = await saveStaticFormat(db, {
      ...(form.code.trim() ? { code: form.code } : {}),
      name: form.name,
      description: form.description,
      mechanism: form.mechanism,
      slots: form.slots,
      variants: form.variants,
      rules: { always: lines(form.always), never: lines(form.never) },
      plate: form.plate,
      text_render: form.text_render,
      sizes: form.sizes,
      // saved by a person: no longer an AI draft
      tags: form.tags.filter(tag => tag !== AI_DRAFT_TAG),
      notes: form.notes,
      ...(form.id ? { reference_images: form.references } : {})
    }, form.id || undefined)
    for (const entry of form.pending) await addStaticReference(db, row, entry.file, entry.file.type, entry.source_url || null)
  }, 'Static format saved')
  saving.value = false
  if (ok) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <USlideover
    :open="open"
    :title="form.id ? `Edit ${form.code}` : 'New static format'"
    :ui="{ content: preview ? 'max-w-5xl' : 'max-w-xl' }"
    @update:open="requestOpen"
  >
    <template #body>
      <div class="grid gap-6" :class="{ 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]': preview }">
        <!-- the example ad, beside the fields, to describe what's in it -->
        <div v-if="preview" class="lg:sticky lg:top-0 lg:self-start">
          <img v-if="preview.url && !preview.pdf" :src="preview.url" alt="The example ad" class="max-h-[70vh] w-full rounded-lg border border-default object-contain">
          <a v-else-if="preview.url" :href="preview.url" target="_blank" rel="noopener" class="flex h-48 items-center justify-center gap-2 rounded-lg border border-default text-sm text-muted">
            <UIcon name="i-lucide-file-text" class="size-5" /> Open the PDF
          </a>
          <div v-else class="flex h-48 items-center justify-center rounded-lg border border-default">
            <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
          </div>
        </div>

        <div class="min-w-0 space-y-5">
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Code" help="Leave it to number itself">
              <UInput v-model="form.code" :placeholder="form.id ? '' : 'Next SF##'" class="w-full font-mono" />
            </UFormField>
            <UFormField label="Name" required class="sm:col-span-2">
              <UInput v-model="form.name" placeholder="Notes app" class="w-full" />
            </UFormField>
          </div>
          <UFormField label="What it is">
            <UTextarea v-model="form.description" autoresize :rows="2" placeholder="An iPhone note, typed in the user's voice" class="w-full" />
          </UFormField>
          <UFormField label="Why it works" help="The mechanism: what makes someone stop and read">
            <UTextarea v-model="form.mechanism" autoresize :rows="2" class="w-full" />
          </UFormField>

          <UFormField label="Copy slots" help="The pieces of copy each ad of this format takes, in order. Copy is written per shoot, for its product." :error="slotProblem ?? undefined">
            <div class="space-y-2">
              <div v-for="(slot, index) in form.slots" :key="slot.uid" class="space-y-2 rounded-lg border border-default p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <UInput v-model="slot.label" placeholder="Headline" class="min-w-0 flex-1" :aria-label="`Slot ${index + 1} name`" />
                  <UInput
                    :model-value="slot.max_words ?? undefined"
                    type="number"
                    min="1"
                    placeholder="Max words"
                    class="w-28"
                    aria-label="Most words"
                    @update:model-value="slot.max_words = Number($event) || null"
                  />
                  <USwitch v-model="slot.required" label="Required" size="sm" />
                  <div class="ml-auto flex">
                    <UButton icon="i-lucide-arrow-up" size="xs" color="neutral" variant="ghost" :disabled="index === 0" aria-label="Move up" @click="moveSlot(index, -1)" />
                    <UButton icon="i-lucide-arrow-down" size="xs" color="neutral" variant="ghost" :disabled="index === form.slots.length - 1" aria-label="Move down" @click="moveSlot(index, 1)" />
                    <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove slot" @click="form.slots.splice(index, 1)" />
                  </div>
                </div>
                <UInput :model-value="slot.guidance ?? ''" placeholder="What to write in it" class="w-full" @update:model-value="slot.guidance = String($event) || null" />
                <UInput :model-value="slot.example ?? ''" icon="i-lucide-quote" placeholder="An example" class="w-full" @update:model-value="slot.example = String($event) || null" />
                <p v-if="slot.label.trim()" class="text-xs text-muted">
                  Key: <span class="font-mono">{{ staticSlotKey(slot.key || slot.label) || '–' }}</span>
                </p>
              </div>
              <UButton label="Add a slot" icon="i-lucide-plus" size="sm" color="neutral" variant="subtle" @click="form.slots.push(blankSlot())" />
            </div>
          </UFormField>

          <UFormField label="Variants" help="Which versions of each ad Kanvas can make. Each is made only when its ingredients are there.">
            <div class="space-y-1.5">
              <UCheckbox
                v-for="item in variantItems"
                :key="item.value"
                :model-value="form.variants.includes(item.value)"
                :label="item.label"
                :description="VARIANT_HELP[item.value]"
                @update:model-value="toggle('variants', item.value, $event === true)"
              />
            </div>
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Always" help="One rule per line">
              <UTextarea v-model="form.always" autoresize :rows="3" class="w-full" />
            </UFormField>
            <UFormField label="Never" help="One rule per line">
              <UTextarea v-model="form.never" autoresize :rows="3" class="w-full" />
            </UFormField>
          </div>

          <UFormField label="Example ads" help="One or more real ads of this format, with where each came from (e.g. a Meta Ad Library link). The first is the main one.">
            <div class="space-y-2">
              <div v-for="(reference, index) in form.references" :key="reference.path" class="flex items-center gap-2">
                <img v-if="links[reference.path] && !isPdf(reference.path)" :src="links[reference.path]" alt="" class="size-12 shrink-0 rounded border border-default object-cover">
                <span v-else class="flex size-12 shrink-0 items-center justify-center rounded border border-default"><UIcon name="i-lucide-file" class="text-muted" /></span>
                <UInput :model-value="reference.source_url ?? ''" type="url" icon="i-lucide-link" placeholder="Where it's from (optional)" class="min-w-0 flex-1" @update:model-value="reference.source_url = String($event) || null" />
                <UButton icon="i-lucide-arrow-up" size="xs" color="neutral" variant="ghost" :disabled="index === 0" aria-label="Move up" @click="moveReference(index, -1)" />
                <UButton icon="i-lucide-arrow-down" size="xs" color="neutral" variant="ghost" :disabled="index === form.references.length - 1" aria-label="Move down" @click="moveReference(index, 1)" />
                <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove" @click="form.references.splice(index, 1)" />
              </div>
              <div v-for="(entry, index) in form.pending" :key="entry.url" class="flex items-center gap-2">
                <img v-if="entry.file.type !== 'application/pdf'" :src="entry.url" alt="" class="size-12 shrink-0 rounded border border-default object-cover">
                <span v-else class="flex size-12 shrink-0 items-center justify-center rounded border border-default"><UIcon name="i-lucide-file" class="text-muted" /></span>
                <UInput v-model="entry.source_url" type="url" icon="i-lucide-link" placeholder="Where it's from (optional)" class="min-w-0 flex-1" />
                <UBadge label="Saved with the format" color="neutral" variant="subtle" size="sm" class="max-sm:hidden" />
                <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove" @click="form.pending.splice(index, 1)" />
              </div>
              <input ref="picker" type="file" :accept="ACCEPT" multiple class="hidden" @change="onPick">
              <UButton label="Add example ads" icon="i-lucide-image-plus" size="sm" color="neutral" variant="subtle" @click="picker?.click()" />
              <p v-if="fileProblem" class="text-xs text-error">
                {{ fileProblem }}
              </p>
            </div>
          </UFormField>

          <UFormField label="Tags">
            <TagInput v-model="form.tags" />
          </UFormField>
          <UFormField label="Notes">
            <UTextarea v-model="form.notes" autoresize :rows="1" class="w-full" />
          </UFormField>

          <UCollapsible v-model:open="advancedOpen">
            <UButton
              label="Advanced"
              color="neutral"
              variant="ghost"
              size="sm"
              :trailing-icon="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="-ml-2"
            />
            <template #content>
              <div class="mt-2 space-y-4">
                <USwitch v-model="form.plate" label="Work from a blank plate" description="Kanvas strips the copy from the example ad and builds each ad on that plate" />
                <UFormField label="Text">
                  <USelect v-model="form.text_render" :items="textRenders" class="w-full" />
                </UFormField>
                <UFormField label="Sizes">
                  <div class="flex flex-wrap gap-4">
                    <UCheckbox
                      v-for="size in STATIC_SIZES"
                      :key="size"
                      :model-value="form.sizes.includes(size)"
                      :label="size.replace('x', ':')"
                      @update:model-value="toggle('sizes', size, $event === true)"
                    />
                  </div>
                </UFormField>
              </div>
            </template>
          </UCollapsible>
        </div>
      </div>
    </template>
    <template #footer>
      <UButton label="Save static format" :loading="saving" :disabled="!canSave" @click="save" />
    </template>
  </USlideover>
</template>
