<script setup lang="ts">
// A brand account's results (restructure Phase 4): the shoots its partner creators make for it, and
// how its Library does across them. Only ever the brand's own shoots: never creators' media, their
// other brands or their own Library (public.partner_shoots, public.partner_item_results).
const db = useDb()
const route = useRoute()
const router = useRouter()

type PartnerShoot = {
  shoot_id: string, code: string, status: string, shoot_date: string | null, started_at: string | null, ended_at: string | null,
  creator_name: string, partnership_active: boolean, product_name: string, channels: string[],
  clips_edited: number, batches: number, batches_measured: number, renders: number
}
type ItemResult = { kind: string, item_id: string, label: string, archived: boolean, shoots: number, winners: number, mids: number, losers: number }

const brand = ref<{ id: string, name: string } | null>(null)
const shoots = ref<PartnerShoot[]>([])
const items = ref<ItemResult[]>([])
async function load() {
  brand.value = must(await db.from('brands').select('id, name').is('source_brand_id', null).order('created_at').limit(1).maybeSingle())
  if (!brand.value) return
  const [s, i] = await Promise.all([
    db.rpc('partner_shoots', { p_brand_id: brand.value.id }),
    db.rpc('partner_item_results', { p_brand_id: brand.value.id })
  ])
  shoots.value = must(s) as PartnerShoot[]
  items.value = must(i) as ItemResult[]
}
await load()

// filters, kept in the URL (?creator=, ?status=) so the Creators page can link here
const creator = computed({
  get: () => typeof route.query.creator === 'string' ? route.query.creator : 'all',
  set: value => router.replace({ query: { ...route.query, creator: value === 'all' ? undefined : value } })
})
const status = computed({
  get: () => typeof route.query.status === 'string' ? route.query.status : 'all',
  set: value => router.replace({ query: { ...route.query, status: value === 'all' ? undefined : value } })
})
const creatorOptions = computed(() => [{ label: 'All creators', value: 'all' }, ...[...new Set(shoots.value.map(row => row.creator_name))].sort().map(name => ({ label: name, value: name }))])
const statusOptions = computed(() => [{ label: 'All statuses', value: 'all' }, ...[...new Set(shoots.value.map(row => row.status))].map(value => ({ label: SHOOT_STATUS_LABELS[value] ?? value, value }))])
const visible = computed(() => shoots.value.filter(row =>
  (creator.value === 'all' || row.creator_name === creator.value) && (status.value === 'all' || row.status === status.value)))

const summary = computed(() => [
  { label: 'Creators', value: new Set(shoots.value.filter(row => row.partnership_active).map(row => row.creator_name)).size },
  { label: 'Shoots', value: shoots.value.length },
  { label: 'Batches measured', value: shoots.value.reduce((sum, row) => sum + row.batches_measured, 0) },
  { label: 'Videos batched', value: shoots.value.reduce((sum, row) => sum + row.renders, 0) }
])

const KIND_LABELS: Record<string, string> = { hook: 'Hook', cta: 'CTA', format: 'Format' }
const libraryRows = computed(() => items.value.filter(row => !row.archived || row.shoots))
const day = (value: string | null) => value ? formatDate(value.slice(0, 10)) : '—'
</script>

<template>
  <UDashboardPanel id="results">
    <template #header>
      <UDashboardNavbar title="Results">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div v-for="tile in summary" :key="tile.label" class="rounded-lg border border-default p-4">
            <p class="text-xs text-muted">
              {{ tile.label }}
            </p>
            <p class="text-2xl font-semibold text-highlighted tabular-nums">
              {{ tile.value }}
            </p>
          </div>
        </div>

        <section class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="font-semibold text-highlighted">
              Shoots for {{ brand?.name ?? 'your brand' }}
            </h2>
            <div class="flex flex-wrap gap-2">
              <USelect v-model="creator" :items="creatorOptions" class="w-44" />
              <USelect v-model="status" :items="statusOptions" class="w-40" />
            </div>
          </div>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50 text-left text-xs text-muted">
                <tr>
                  <th class="px-3 py-2 font-medium">
                    Shoot
                  </th>
                  <th class="px-3 py-2 font-medium">
                    Creator
                  </th>
                  <th class="px-3 py-2 font-medium">
                    Product
                  </th>
                  <th class="px-3 py-2 font-medium">
                    Date
                  </th>
                  <th class="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Clips edited
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Batches
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="row in visible" :key="row.shoot_id">
                  <td class="px-3 py-2 font-mono font-medium text-highlighted">
                    {{ row.code }}
                  </td>
                  <td class="px-3 py-2">
                    {{ row.creator_name }}
                    <span v-if="row.channels.length" class="block text-xs text-muted">{{ row.channels.join(' · ') }}</span>
                    <UBadge v-if="!row.partnership_active" label="Ended" color="neutral" variant="outline" size="sm" />
                  </td>
                  <td class="px-3 py-2">
                    {{ row.product_name }}
                  </td>
                  <td class="px-3 py-2 tabular-nums">
                    {{ day(row.shoot_date) }}
                  </td>
                  <td class="px-3 py-2">
                    <UBadge :label="SHOOT_STATUS_LABELS[row.status] ?? row.status" :color="SHOOT_STATUS_COLORS[row.status]" variant="subtle" class="capitalize" />
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ row.clips_edited || '—' }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    <template v-if="row.batches">
                      {{ row.batches_measured }} / {{ row.batches }} measured
                    </template>
                    <template v-else>
                      —
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!visible.length" class="px-3 py-6 text-center text-sm text-muted">
              {{ shoots.length ? 'No shoots match these filters.' : 'No shoots yet. When your creators plan shoots for you, they show here.' }}
            </p>
          </div>
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="font-semibold text-highlighted">
              Your Library
            </h2>
            <p class="text-sm text-muted">
              How your hooks, CTAs and formats do on your creators' shoots: how many shoots used each, and how its batches scored.
            </p>
          </div>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50 text-left text-xs text-muted">
                <tr>
                  <th class="px-3 py-2 font-medium">
                    Item
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Shoots
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Winners
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Mid
                  </th>
                  <th class="px-3 py-2 text-right font-medium">
                    Losers
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="row in libraryRows" :key="`${row.kind}:${row.item_id}`">
                  <td class="px-3 py-2">
                    <UBadge :label="KIND_LABELS[row.kind] ?? row.kind" color="neutral" variant="subtle" size="sm" class="mr-2" />
                    <span class="text-highlighted">{{ row.label }}</span>
                    <UBadge v-if="row.archived" label="Archived" color="neutral" variant="outline" size="sm" class="ml-2" />
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ row.shoots }}
                  </td>
                  <td class="px-3 py-2 text-right font-medium tabular-nums text-success">
                    {{ row.winners }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ row.mids }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-error">
                    {{ row.losers }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!libraryRows.length" class="px-3 py-6 text-center text-sm text-muted">
              Nothing in your Library yet: add hooks, CTAs and formats there for your creators to use.
            </p>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
