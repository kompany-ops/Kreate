<script setup lang="ts">
import type { Row } from '#shared/types/models'

// Treatments: ways a finished recipe is presented, one set for every account (changed by Kreate,
// not from here). Each treatment that's on makes another version of every recipe that has what it
// needs, alongside the untreated one; each shoot can switch any of them off for itself (its
// General tab). Kreate decides where they apply, Klip makes what each needs (by its component: a
// cut-out, retro captions, a search query…), and Klip's renderer composes them (docs/contract.md).
const library = useLibrary('treatments', { text: row => `${row.name} ${row.description ?? ''}` })

const KINDS = [
  { label: 'Layout', value: 'layout' },
  { label: 'Overlay', value: 'overlay' },
  { label: 'Footage', value: 'footage' }
]
const PLACEMENTS = [
  { label: 'The hook', value: 'hook' },
  { label: 'The whole video', value: 'video' },
  { label: 'The CTA', value: 'cta' }
]
const NEEDS = [
  { label: 'Text written for it', value: 'text' },
  { label: "The speaker's video", value: 'speaker_video' },
  { label: 'Old footage', value: 'old_footage' },
  { label: "The shoot's offer", value: 'offer' }
]
const labelOf = (list: { label: string, value: string }[], value: string) => list.find(entry => entry.value === value)?.label ?? value

// the ones in use, built-in first, then in their own order
const list = computed(() => library.visible().filter(row => row.active)
  .sort((a, b) => Number(b.system) - Number(a.system) || a.sort_order - b.sort_order))
const pageRows = computed(() => library.paginate(list.value))
const byId = (id: string) => library.rows.value.find(row => row.id === id)
const partNames = (row: Row<'treatments'>) => row.parts.map(id => byId(id)?.name ?? 'a removed treatment').join(' + ')
</script>

<template>
  <div class="space-y-4">
    <UInput v-model="library.search.value" icon="i-lucide-search" placeholder="Search treatments" class="w-full sm:w-72" />

    <p class="text-sm text-muted">
      Every account has these treatments. Each one makes an extra version of every recipe that has what it needs, alongside the untreated one. Switch any off for a shoot on its General tab.
    </p>

    <div class="divide-y divide-default rounded-lg border border-default">
      <div
        v-for="row in pageRows"
        :key="row.id"
        class="flex items-start gap-3 px-4 py-3"
      >
        <div class="min-w-0 flex-1 space-y-1.5">
          <p class="flex flex-wrap items-center gap-2 font-medium text-highlighted">
            {{ row.name }}
            <UBadge v-if="row.system" label="Built in" icon="i-lucide-lock" color="neutral" variant="outline" size="sm" />
            <UBadge v-if="row.parts.length" :label="`Combines ${partNames(row)}`" icon="i-lucide-layers" color="secondary" variant="subtle" size="sm" />
          </p>
          <p v-if="row.description" class="text-sm text-muted">
            {{ row.description }}
          </p>
          <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <template v-if="!row.parts.length">
              <UBadge :label="labelOf(KINDS, row.kind)" color="primary" variant="subtle" size="sm" />
              <UBadge :label="labelOf(PLACEMENTS, row.placement)" color="neutral" variant="subtle" size="sm" />
            </template>
            <UBadge v-for="need in row.needs" :key="need" :label="`Needs ${labelOf(NEEDS, need).toLowerCase()}`" color="neutral" variant="outline" size="sm" />
            <SourceLink :url="row.source_url" />
          </div>
        </div>
      </div>
      <div v-if="library.loading.value" class="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading…
      </div>
      <p v-else-if="!list.length" class="px-4 py-10 text-center text-sm text-muted">
        No treatments here.
      </p>
    </div>
    <ListPager v-model:page="library.page.value" :total="list.length" :page-size="library.pageSize" />
  </div>
</template>
