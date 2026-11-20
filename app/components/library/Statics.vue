<script setup lang="ts">
import type { Row } from '#shared/types/models'

// Statics: the Library's static ad formats (docs/spec-statics.md §2). Brand-agnostic structures
// like Notes app or Offer-first banner, each with copy slots, the variants it can be made in, rules
// and example ads. Copy is written in each shoot, for its product; Kanvas makes the ads.
const db = useDb()
const run = useAction()
const lib = useLibrary('static_formats', { text: row => `${row.code} ${row.name} ${row.description ?? ''} ${row.tags.join(' ')}` })
const editor = useTemplateRef<{ edit: (row?: Row<'static_formats'>, duplicate?: boolean) => void, fromExample: (file: File) => void }>('editor')

// --- filters ---------------------------------------------------------------------------------
const variant = ref('all')
const tag = ref('all')
const variantFilter = [{ label: 'Every variant', value: 'all' }, ...STATIC_VARIANTS.map(value => ({ label: STATIC_VARIANT_LABELS[value], value }))]
const tagFilter = computed(() => [{ label: 'Every tag', value: 'all' }, ...[...new Set(lib.rows.value.flatMap(row => row.tags))].sort().map(value => ({ label: value, value }))])
watch([variant, tag], lib.resetPage)
const list = computed(() => lib.visible(row =>
  (variant.value === 'all' || row.variants.includes(variant.value)) && (tag.value === 'all' || row.tags.includes(tag.value))))
const page = computed(() => lib.paginate(list.value))

// "used in N shoots": the shoots each format is added to
const usage = ref<Record<string, number>>({})
async function loadUsage() {
  const rows = must(await db.from('shoot_static_formats').select('static_format_id'))
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.static_format_id] = (counts[row.static_format_id] ?? 0) + 1
  usage.value = counts
}
run(loadUsage)

// each row's first example ad, as a thumbnail (private files: signed links)
const thumbs = ref<Record<string, string>>({})
watch(page, async (rows) => {
  const paths = rows.map(row => parseStaticReferences(row.reference_images)[0]?.path).filter((path): path is string => !!path && !thumbs.value[path] && !path.endsWith('.pdf'))
  if (paths.length) thumbs.value = { ...thumbs.value, ...await signedStaticReferences(db, paths).catch(() => ({})) }
}, { immediate: true })
const thumbOf = (row: Row<'static_formats'>) => parseStaticReferences(row.reference_images)[0]?.path

// a link to one format (e.g. shared in chat) opens it
const route = useRoute()
watch(() => [lib.rows.value.length, route.query.open, !!editor.value], () => {
  const row = lib.rows.value.find(entry => entry.id === route.query.open)
  if (row && editor.value) editor.value.edit(row)
}, { immediate: true })

// --- from an example ad ---------------------------------------------------------------------
const examplePicker = useTemplateRef<HTMLInputElement>('examplePicker')
function onExample(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) editor.value?.fromExample(file)
}

// --- CSV import: drafts without slots, to finish by hand or with the AI ---------------------
const importOpen = ref(false)
const importing = ref(false)
const parsed = ref<ReturnType<typeof parseStaticFormatsCsv> | null>(null)
const importProblem = ref('')
const csvPicker = useTemplateRef<HTMLInputElement>('csvPicker')
async function onCsv(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importProblem.value = ''
  parsed.value = null
  try {
    parsed.value = parseStaticFormatsCsv(await file.text())
  } catch (error) {
    importProblem.value = (error as Error).message
  }
  importOpen.value = true
}
async function runImport() {
  if (!parsed.value) return
  importing.value = true
  const formats = parsed.value.formats
  const ok = await run(async () => {
    for (const format of formats) {
      await saveStaticFormat(db, { ...format, tags: [...new Set([...format.tags, 'imported'])] })
    }
    await lib.reload()
  }, `Imported ${formats.length} static format${formats.length === 1 ? '' : 's'}`)
  importing.value = false
  if (ok) importOpen.value = false
}

const slotCount = (row: Row<'static_formats'>) => parseStaticSlots(row.slots).length
</script>

<template>
  <div class="space-y-4">
    <LibraryToolbar
      v-model:search="lib.search.value"
      v-model:sort="lib.sort.value"
      v-model:show-archived="lib.showArchived.value"
      new-label="New format"
      @create="editor?.edit()"
    >
      <USelect v-model="variant" :items="variantFilter" class="w-44" aria-label="Variant" />
      <USelect v-if="tagFilter.length > 1" v-model="tag" :items="tagFilter" class="w-36" aria-label="Tag" />
      <template #actions>
        <input ref="examplePicker" type="file" :accept="Object.keys(STATIC_REFERENCE_TYPES).join(',')" class="hidden" @change="onExample">
        <input ref="csvPicker" type="file" accept=".csv,text/csv" class="hidden" @change="onCsv">
        <UDropdownMenu
          :items="[
            { label: 'From an example ad', icon: 'i-lucide-image-plus', onSelect: () => examplePicker?.click() },
            { label: 'Import CSV', icon: 'i-lucide-file-spreadsheet', onSelect: () => csvPicker?.click() }
          ]"
        >
          <UButton label="Add from…" icon="i-lucide-chevron-down" trailing color="neutral" variant="subtle" :ui="ICON_ON_MOBILE" />
        </UDropdownMenu>
      </template>
    </LibraryToolbar>

    <div v-if="lib.loading.value" class="flex items-center justify-center gap-2 rounded-lg border border-default px-4 py-10 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Loading…
    </div>

    <p v-else-if="!list.length" class="rounded-lg border border-default px-4 py-10 text-center text-sm text-muted">
      {{ lib.search.value || lib.showArchived.value || variant !== 'all' || tag !== 'all'
        ? 'Nothing matches.'
        : 'No static formats yet. Start from an example ad, import a CSV, or make one from scratch.' }}
    </p>

    <div v-else class="divide-y divide-default rounded-lg border border-default">
      <div
        v-for="format in page"
        :key="format.id"
        class="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-elevated/50"
        @click="editor?.edit(format)"
      >
        <div class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded border border-default bg-elevated/50">
          <img v-if="thumbOf(format) && thumbs[thumbOf(format)!]" :src="thumbs[thumbOf(format)!]" alt="" class="size-full object-cover">
          <UIcon v-else :name="thumbOf(format) ? 'i-lucide-file' : 'i-lucide-image'" class="size-5 text-dimmed" />
        </div>
        <div class="min-w-0 flex-1 space-y-1">
          <p class="text-highlighted">
            <span class="mr-2 font-mono font-semibold">{{ format.code }}</span>
            <span class="font-medium">{{ format.name }}</span>
            <UBadge v-if="format.tags.includes(AI_DRAFT_TAG)" label="AI draft" icon="i-lucide-sparkles" color="primary" variant="subtle" size="sm" class="ml-2" />
            <UBadge v-if="format.archived" label="Archived" color="neutral" variant="subtle" size="sm" class="ml-2" />
          </p>
          <p v-if="format.description" class="line-clamp-2 text-sm text-muted">
            {{ format.description }}
          </p>
          <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <UBadge v-for="value in format.variants" :key="value" :label="STATIC_VARIANT_LABELS[value as StaticVariant] ?? value" color="neutral" variant="subtle" size="sm" />
            <span>· {{ slotCount(format) ? `${slotCount(format)} slot${slotCount(format) === 1 ? '' : 's'}` : 'no slots yet' }}</span>
            <UBadge v-for="value in format.tags.filter(entry => entry !== AI_DRAFT_TAG)" :key="value" :label="value" color="neutral" variant="outline" size="sm" />
            <CreatedBy :by="format.created_by" :at="format.created_at" />
          </div>
        </div>
        <UBadge
          :label="`${usage[format.id] ?? 0} shoot${usage[format.id] === 1 ? '' : 's'}`"
          icon="i-lucide-clapperboard"
          color="neutral"
          variant="outline"
          class="shrink-0 max-sm:hidden"
        />
        <LibraryRowActions
          noun="static format"
          :archived="format.archived"
          duplicable
          @duplicate="editor?.edit(format, true)"
          @archive="lib.setArchived(format, $event)"
        />
      </div>
    </div>

    <ListPager v-model:page="lib.page.value" :total="list.length" :page-size="lib.pageSize" />

    <LibraryStaticFormatEditor ref="editor" @saved="lib.reload" />

    <UModal v-model:open="importOpen" title="Import static formats">
      <template #body>
        <div class="space-y-3 text-sm">
          <p v-if="importProblem" class="text-error">
            {{ importProblem }}
          </p>
          <template v-else-if="parsed">
            <p class="text-muted">
              {{ parsed.formats.length }} format{{ parsed.formats.length === 1 ? '' : 's' }} to add as drafts without slots, tagged "imported", to finish by hand or with your AI.
              <template v-if="parsed.skipped">
                {{ parsed.skipped }} row{{ parsed.skipped === 1 ? '' : 's' }} without a name will be skipped.
              </template>
            </p>
            <ul class="max-h-72 divide-y divide-default overflow-y-auto rounded-lg border border-default">
              <li v-for="(format, index) in parsed.formats" :key="index" class="px-3 py-2">
                <p class="font-medium text-highlighted">
                  {{ format.name }}
                </p>
                <p class="text-xs text-muted">
                  {{ format.variants.map(value => STATIC_VARIANT_LABELS[value]).join(', ') }}
                  <template v-if="format.rules.always.length + format.rules.never.length">
                    · {{ format.rules.always.length + format.rules.never.length }} rule{{ format.rules.always.length + format.rules.never.length === 1 ? '' : 's' }}
                  </template>
                </p>
              </li>
            </ul>
          </template>
          <p class="text-xs text-muted">
            Columns: Name (needed), Description, Mechanism, Variants (e.g. "text, text + product"), Always and Never (one rule per line or separated by ;), or a Rules column whose lines start "Never" or "Don't", and Tags.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="importOpen = false" />
          <UButton label="Import" icon="i-lucide-upload" :loading="importing" :disabled="!parsed?.formats.length" @click="runImport" />
        </div>
      </template>
    </UModal>
  </div>
</template>
