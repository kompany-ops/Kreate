<script setup lang="ts">
import type { Row } from '#shared/types/models'

type BrandRow = Row<'brands'> & {
  brand_channels: { channel_id: string }[]
  products: { id: string }[]
  /** how it pays this account: the team's only (null: no terms yet) */
  deal: Row<'brand_deals'> | null
}

const db = useDb()
const run = useAction()
const toast = useToast()
const route = useRoute()
const router = useRouter()
const { channels, load } = useRefData()
const { access, isAdmin } = useAccess()
const { currentOrg } = useOrg()
const { confirmDialog } = useConfirm()

// Grid (cards), list (a table) or board (a column per status, to move brands along). The view
// lives in the URL so it survives reloads and can be linked.
const VIEWS = [
  { label: 'Grid', value: 'grid', icon: 'i-lucide-layout-grid' },
  { label: 'List', value: 'list', icon: 'i-lucide-list' },
  { label: 'Board', value: 'board', icon: 'i-lucide-square-kanban' }
] as const
type View = typeof VIEWS[number]['value']
const view = computed<View>({
  get: () => VIEWS.some(entry => entry.value === route.query.view) ? route.query.view as View : 'grid',
  set: value => router.replace({ query: { ...route.query, view: value === 'grid' ? undefined : value } })
})

const brands = ref<BrandRow[]>([])
const search = ref('')
const status = ref('all')
// archived brands are hidden unless this is set to Archived
const statusOptions = [{ label: 'All statuses', value: 'all' }, ...selectOptions(BRAND_STATUSES), { label: 'Archived', value: 'archived' }]

async function loadBrands() {
  // In pages: the Data API returns at most 1,000 rows per request, and imports can bring in more.
  const all: BrandRow[] = []
  for (let from = 0; ; from += 1000) {
    const page = must(await db
      .from('brands')
      .select('*, brand_channels(channel_id), products(id), deal:brand_deals(*)')
      .order('name')
      .range(from, from + 999))
    // one deal per brand, which the Data API returns as a list (it's linked by account and brand)
    all.push(...page.map(row => ({ ...row, deal: (Array.isArray(row.deal) ? row.deal[0] : row.deal) ?? null }) as unknown as BrandRow))
    if (page.length < 1000) break
  }
  brands.value = all
}
// partner brands: who each one is from (restructure Phase 3)
const partnerOf = ref(new Map<string, string>())
async function loadPartners() {
  const rows = must(await db.from('partnerships').select('linked_brand_id, publisher_name').not('linked_brand_id', 'is', null))
  partnerOf.value = new Map(rows.map(row => [row.linked_brand_id!, row.publisher_name]))
}
const fromPartner = (brand: BrandRow) => brand.source_brand_id ? partnerOf.value.get(brand.id) ?? 'a partner' : null
/** "From Calm Co" for a brand's own; "Via Paw Agency" for one an agency brings */
const partnerLabel = (brand: BrandRow) => {
  const partner = fromPartner(brand)
  return partner ? `${partner === brand.name ? 'From' : 'Via'} ${partner}` : null
}

// invitations waiting for your email: accept one into this account, on the channels you choose
type Invite = { id: string, publisher_name: string, brand_name: string, about: string | null, logo_url: string | null }
const invites = ref<Invite[]>([])
async function loadInvites() {
  const { data } = await db.rpc('my_partner_invites')
  invites.value = (data ?? []) as Invite[]
}
await Promise.all([load(), loadBrands(), loadPartners(), loadInvites()])

const accepting = ref<Invite | null>(null)
const acceptChannels = ref<string[]>([])
const activeChannels = computed(() => channels.value.filter(channel => channel.active))
function startAccept(invite: Invite) {
  accepting.value = invite
  acceptChannels.value = activeChannels.value.map(channel => channel.id)
}
const savingInvite = ref(false)
async function accept() {
  const invite = accepting.value
  if (!invite || !currentOrg.value) return
  savingInvite.value = true
  const ok = await run(async () => {
    const { error } = await db.rpc('accept_partnership', { p_id: invite.id, p_org_id: currentOrg.value!.id, p_channel_ids: acceptChannels.value })
    if (error) throw error
    await Promise.all([loadBrands(), loadPartners(), loadInvites(), load(true)])
  }, `${invite.brand_name} is one of your brands`)
  savingInvite.value = false
  if (ok) accepting.value = null
}
async function decline(invite: Invite) {
  if (!(await confirmDialog({
    title: `Decline ${invite.brand_name}'s invitation?`,
    description: 'They can invite you again later.',
    confirmLabel: 'Decline',
    danger: true
  }))) return
  await run(async () => {
    const { error } = await db.rpc('decline_partnership', { p_id: invite.id })
    if (error) throw error
    await loadInvites()
  }, 'Declined')
}

// --- filters ---------------------------------------------------------------
// A brand with no value for a filtered field (e.g. no Trybe score yet) is left out by that filter.
const DEFAULT_FILTERS = {
  minScore: 0,
  payType: 'all',
  minCommission: 0,
  minFlat: 0,
  category: 'all',
  channel: 'all',
  matched: 'all',
  /** all, mine (your own brands) or partners (partner brands) */
  source: 'all',
  starred: false
}
const filters = reactive({ ...DEFAULT_FILTERS })
const activeFilters = computed(() =>
  (Object.keys(DEFAULT_FILTERS) as (keyof typeof DEFAULT_FILTERS)[]).filter(key => filters[key] !== DEFAULT_FILTERS[key]).length
)
const clearFilters = () => Object.assign(filters, DEFAULT_FILTERS)

const scoreOptions = [{ label: 'Any score', value: 0 }, ...[50, 60, 70, 80, 90].map(n => ({ label: `${n}+`, value: n }))]
const payOptions = [{ label: 'Any income', value: 'all' }, ...PAY_TYPES.map(type => ({ label: type.label, value: type.value })), { label: 'Not set', value: 'none' }]
const commissionOptions = [{ label: 'Any commission', value: 0 }, ...[5, 10, 15, 20, 30].map(n => ({ label: `${n}%+`, value: n }))]
const flatOptions = [{ label: 'Any flat fee', value: 0 }, ...[10, 25, 50, 100, 250].map(n => ({ label: `${n}+ per video`, value: n }))]
const matchedOptions = [
  { label: 'Any', value: 'all' },
  { label: 'Matched in Scrybe', value: 'yes' },
  { label: 'Didn\'t match', value: 'no' },
  { label: 'Unknown', value: 'unknown' }
]

const trybe = (brand: BrandRow) => (brand.trybe_data ?? {}) as { categories?: string[], matched?: string, logo?: unknown }

/** Trybe categories across all brands, most common first. */
const categoryOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const brand of brands.value) for (const category of trybe(brand).categories ?? []) counts.set(category, (counts.get(category) ?? 0) + 1)
  return [
    { label: 'Any category', value: 'all' },
    ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => ({ label: `${category} (${count})`, value: category }))
  ]
})
const channelFilterOptions = computed(() => [
  { label: 'Any channel', value: 'all' },
  ...channels.value.map(channel => ({ label: channel.name, value: channel.id })),
  { label: 'No channels assigned', value: 'none' }
])

const sort = ref('name')
const sortOptions = [
  { label: 'Name A–Z', value: 'name' },
  { label: 'Trybe score', value: 'score' },
  { label: 'Commission', value: 'commission' },
  { label: 'Flat fee', value: 'flat' },
  { label: 'Retainer', value: 'retainer' },
  { label: 'Ad spend', value: 'ad_spend' },
  { label: 'Newest', value: 'newest' }
]

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  const list = brands.value.filter((brand) => {
    const data = trybe(brand)
    // the board's columns are the statuses, so it ignores the status filter
    const archivedView = status.value === 'archived' && view.value !== 'board'
    return (archivedView ? brand.archived_at !== null : brand.archived_at === null)
      && (view.value === 'board' || archivedView || status.value === 'all' || brand.status === status.value)
      && (!filters.starred || brand.starred)
      && (!term || brand.name.toLowerCase().includes(term))
      && (!filters.minScore || (brand.trybe_score !== null && Number(brand.trybe_score) >= filters.minScore))
      && (filters.payType === 'all' || (filters.payType === 'none' ? !brand.deal?.pay_types.length : !!brand.deal?.pay_types.includes(filters.payType)))
      && (!filters.minCommission || (brand.deal?.commission_pct != null && Number(brand.deal.commission_pct) >= filters.minCommission))
      && (!filters.minFlat || (brand.deal?.flat_fee != null && Number(brand.deal.flat_fee) >= filters.minFlat))
      && (filters.category === 'all' || (data.categories ?? []).includes(filters.category))
      && (filters.channel === 'all' || (filters.channel === 'none'
        ? !brand.brand_channels.length
        : brand.brand_channels.some(link => link.channel_id === filters.channel)))
      && (filters.matched === 'all' || data.matched === filters.matched)
      && (filters.source === 'all' || (filters.source === 'mine' ? !brand.source_brand_id : !!brand.source_brand_id))
  })
  // brands without the sorted value go last
  const desc = (pick: (brand: BrandRow) => number | null) => (a: BrandRow, b: BrandRow) =>
    (pick(b) ?? -Infinity) - (pick(a) ?? -Infinity) || a.name.localeCompare(b.name)
  const sorters: Record<string, (a: BrandRow, b: BrandRow) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    score: desc(brand => brand.trybe_score === null ? null : Number(brand.trybe_score)),
    commission: desc(brand => brand.deal?.commission_pct == null ? null : Number(brand.deal.commission_pct)),
    flat: desc(brand => brand.deal?.flat_fee == null ? null : Number(brand.deal.flat_fee)),
    retainer: desc(brand => brand.deal?.retainer_fee == null ? null : Number(brand.deal.retainer_fee)),
    ad_spend: desc(brand => brand.deal?.ad_spend_pct == null ? null : Number(brand.deal.ad_spend_pct)),
    newest: (a, b) => b.created_at.localeCompare(a.created_at)
  }
  return list.sort(sorters[sort.value] ?? sorters.name)
})

// 24 per page fits the 1-, 2- and 3-column grids evenly.
const page = ref(1)
const pageSize = 24
watch([search, status, sort, filters], () => {
  page.value = 1
})
const pageBrands = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

// --- board -----------------------------------------------------------------
// Each column shows its first 50 brands until asked for more: an import can bring in thousands.
const COLUMN_STEP = 50
const columnLimit = reactive<Record<string, number>>({})
const columns = computed(() => BRAND_STATUSES.map((name) => {
  const all = filtered.value.filter(brand => brand.status === name)
  return { status: name, all, shown: all.slice(0, columnLimit[name] ?? COLUMN_STEP) }
}))

/** Move a brand to another status, straight away (put back if saving fails). */
async function moveBrand(brand: BrandRow, next: string) {
  if (brand.status === next) return
  const before = brand.status
  brand.status = next
  const { error } = await db.from('brands').update({ status: next }).eq('id', brand.id)
  if (error) {
    brand.status = before
    toast.add({ title: `Couldn't move ${brand.name}`, description: error.message, color: 'error' })
  }
}

/** Star or unstar a brand, straight away (put back if saving fails). */
async function toggleStar(brand: BrandRow) {
  brand.starred = !brand.starred
  const { error } = await db.from('brands').update({ starred: brand.starred }).eq('id', brand.id)
  if (error) {
    brand.starred = !brand.starred
    toast.add({ title: `Couldn't star ${brand.name}`, description: error.message, color: 'error' })
  }
}

const dragging = ref<string | null>(null)
const dropTarget = ref<string | null>(null)
function onDragStart(event: DragEvent, brand: BrandRow) {
  dragging.value = brand.id
  event.dataTransfer?.setData('text/plain', brand.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragEnd() {
  dragging.value = null
  dropTarget.value = null
}
function onDrop(next: string) {
  const brand = brands.value.find(row => row.id === dragging.value)
  onDragEnd()
  if (brand) moveBrand(brand, next)
}

/** The other statuses a card's menu can move it to. */
const moveItems = (brand: BrandRow) => BRAND_STATUSES.filter(name => name !== brand.status).map(name => ({
  label: `Move to ${name}`,
  onSelect: () => moveBrand(brand, name)
}))

const trybeLogo = (brand: BrandRow) => {
  const logo = trybe(brand).logo
  return typeof logo === 'string' && /^https?:\/\//.test(logo) ? logo : null
}

const channelName = (id: string) => channels.value.find(channel => channel.id === id)?.name ?? '?'

const open = ref(false)
const saving = ref(false)
const draft = reactive({ name: '', slug: '', status: 'prospect' })
const requestOpen = useGuardedClose(open, draft)
watch(() => draft.name, (name) => {
  draft.slug = slugify(name)
})

const deal = ref(toBrandDeal())

function create() {
  Object.assign(draft, { name: '', slug: '', status: 'prospect' })
  deal.value = toBrandDeal()
  open.value = true
}

async function save() {
  saving.value = true
  await run(async () => {
    const fields = fromBrandDeal(deal.value)
    const brand = mustOne(await db.from('brands').insert({ name: draft.name.trim(), slug: draft.slug, status: draft.status, ...fields.brand }).select('*').single())
    must(await db.from('brand_deals').insert({ brand_id: brand.id, ...fields.deal }))
    open.value = false
    await navigateTo(`/brands/${brand.id}`)
  })
  saving.value = false
}
</script>

<template>
  <!-- on the board, the page itself doesn't scroll: each column scrolls its own cards -->
  <UDashboardPanel id="brands" :ui="{ body: view === 'board' ? 'overflow-hidden' : undefined }">
    <template #header>
      <UDashboardNavbar title="Brands">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <BrandImport @imported="loadBrands" />
          <UButton icon="i-lucide-plus" label="New brand" @click="create" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex w-full flex-wrap items-center gap-2 py-2">
          <UInput v-model="search" icon="i-lucide-search" placeholder="Search brands" class="w-full sm:w-56" />
          <USelect v-if="view !== 'board'" v-model="status" :items="statusOptions" class="w-36" />
          <USelect v-model="sort" :items="sortOptions" icon="i-lucide-arrow-up-down" class="w-40" />

          <UButton
            icon="i-lucide-star"
            label="Starred"
            :color="filters.starred ? 'warning' : 'neutral'"
            :variant="filters.starred ? 'soft' : 'subtle'"
            :aria-pressed="filters.starred"
            :ui="{ leadingIcon: filters.starred ? 'fill-current' : undefined }"
            @click="filters.starred = !filters.starred"
          />

          <UPopover :content="{ align: 'start' }">
            <UButton
              icon="i-lucide-sliders-horizontal"
              :label="activeFilters ? `Filters (${activeFilters})` : 'Filters'"
              :color="activeFilters ? 'primary' : 'neutral'"
              :variant="activeFilters ? 'soft' : 'subtle'"
            />
            <template #content>
              <div class="grid w-80 gap-3 p-4">
                <UFormField label="Trybe score">
                  <USelect v-model="filters.minScore" :items="scoreOptions" class="w-full" />
                </UFormField>
                <UFormField label="Income">
                  <USelect v-model="filters.payType" :items="payOptions" class="w-full" />
                </UFormField>
                <div class="grid grid-cols-2 gap-3">
                  <UFormField label="Commission">
                    <USelect v-model="filters.minCommission" :items="commissionOptions" class="w-full" />
                  </UFormField>
                  <UFormField label="Flat fee">
                    <USelect v-model="filters.minFlat" :items="flatOptions" class="w-full" />
                  </UFormField>
                </div>
                <UFormField label="Trybe category">
                  <USelectMenu v-model="filters.category" :items="categoryOptions" value-key="value" class="w-full" />
                </UFormField>
                <UFormField label="Channel">
                  <USelect v-model="filters.channel" :items="channelFilterOptions" class="w-full" />
                </UFormField>
                <UFormField label="Whose">
                  <USelect v-model="filters.source" :items="[{ label: 'All brands', value: 'all' }, { label: 'Your own', value: 'mine' }, { label: 'Partnerships', value: 'partners' }]" class="w-full" />
                </UFormField>
                <UFormField label="Scrybe match">
                  <USelect v-model="filters.matched" :items="matchedOptions" class="w-full" />
                </UFormField>
                <UButton
                  v-if="activeFilters"
                  label="Clear filters"
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  class="justify-self-start"
                  @click="clearFilters"
                />
              </div>
            </template>
          </UPopover>

          <span class="text-sm text-muted tabular-nums">
            {{ filtered.length }} of {{ brands.length }}
          </span>

          <UFieldGroup class="ml-auto">
            <UTooltip v-for="entry in VIEWS" :key="entry.value" :text="entry.label">
              <UButton
                :icon="entry.icon"
                :aria-label="`${entry.label} view`"
                :aria-pressed="view === entry.value"
                color="neutral"
                variant="subtle"
                :class="view === entry.value ? 'bg-white text-neutral-950 hover:bg-white' : undefined"
                :ui="view === entry.value ? { leadingIcon: 'text-neutral-950' } : undefined"
                @click="view = entry.value"
              />
            </UTooltip>
          </UFieldGroup>
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div v-if="invites.length" class="mb-4 space-y-2">
        <div v-for="invite in invites" :key="invite.id" class="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <img v-if="invite.logo_url" :src="invite.logo_url" alt="" class="size-8 shrink-0 rounded object-cover" referrerpolicy="no-referrer">
          <div class="min-w-0 flex-1">
            <p class="font-medium text-highlighted">
              {{ invite.publisher_name }} wants to partner with you on {{ invite.brand_name }}
            </p>
            <p class="text-sm text-muted">
              {{ invite.about || 'Its products and Library join your brands, kept up to date. Your deal and channels stay yours.' }}
            </p>
          </div>
          <template v-if="isAdmin && access?.kind === 'creator'">
            <UButton label="Decline" color="neutral" variant="ghost" size="sm" @click="decline(invite)" />
            <UButton label="Accept" icon="i-lucide-handshake" size="sm" @click="startAccept(invite)" />
          </template>
          <span v-else class="text-xs text-muted">Switch to a creator account you're on the team of to accept it.</span>
        </div>
      </div>

      <UModal :open="!!accepting" :title="accepting ? `Partner with ${accepting.brand_name}` : ''" @update:open="open => { if (!open) accepting = null }">
        <template #body>
          <div class="space-y-4">
            <p class="text-sm text-muted">
              {{ accepting?.brand_name }} joins {{ currentOrg?.name }}'s brands, with its products and Library. Which channels is it for?
            </p>
            <UCheckboxGroup
              v-model="acceptChannels"
              :items="activeChannels.map(channel => ({ label: channel.name, value: channel.id }))"
            />
            <p v-if="!activeChannels.length" class="text-sm text-muted">
              No channels yet: you can choose them on the brand's page later.
            </p>
          </div>
        </template>
        <template #footer>
          <UButton label="Accept" icon="i-lucide-handshake" :loading="savingInvite" @click="accept" />
        </template>
      </UModal>

      <div v-if="view === 'grid'" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <NuxtLink
          v-for="brand in pageBrands"
          :key="brand.id"
          :to="`/brands/${brand.id}`"
          class="rounded-lg border border-default p-4 transition hover:bg-elevated/50"
        >
          <div class="flex items-start justify-between gap-2">
            <h2 class="flex min-w-0 items-center gap-2 font-semibold text-highlighted">
              <img
                v-if="trybeLogo(brand)"
                :src="trybeLogo(brand)!"
                alt=""
                class="size-6 shrink-0 rounded object-cover"
                loading="lazy"
                referrerpolicy="no-referrer"
              >
              <span class="truncate">{{ brand.name }}</span>
            </h2>
            <div class="flex shrink-0 items-center gap-1">
              <BrandStar :starred="brand.starred" :name="brand.name" @toggle="toggleStar(brand)" />
              <UBadge v-if="partnerLabel(brand)" :label="partnerLabel(brand)!" icon="i-lucide-handshake" color="secondary" variant="subtle" />
              <UBadge v-if="brand.archived_at" label="Archived" color="neutral" variant="outline" />
              <UBadge v-else :label="brand.status" :color="BRAND_STATUS_COLORS[brand.status]" variant="subtle" class="capitalize" />
            </div>
          </div>
          <p class="mt-1 text-sm text-muted">
            {{ brand.products.length }} product{{ brand.products.length === 1 ? '' : 's' }}
            <template v-if="dealSummary(brand.deal)">
              · {{ dealSummary(brand.deal) }}
            </template>
            <template v-if="brand.trybe_score !== null">
              · Trybe score {{ Number(brand.trybe_score) }}
            </template>
          </p>
          <div class="mt-3 flex flex-wrap gap-1">
            <UBadge
              v-for="link in brand.brand_channels"
              :key="link.channel_id"
              :label="channelName(link.channel_id)"
              color="neutral"
              variant="outline"
            />
            <span v-if="!brand.brand_channels.length" class="text-xs text-dimmed">No channels assigned</span>
          </div>
          <CreatedBy :by="brand.created_by" :at="brand.created_at" class="mt-2 block" />
        </NuxtLink>
      </div>

      <!-- List: one row per brand -->
      <div v-else-if="view === 'list' && filtered.length" class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-default bg-elevated/50 text-xs text-muted">
            <tr>
              <th class="w-8 px-1 py-2">
                <span class="sr-only">Starred</span>
              </th>
              <th class="px-3 py-2 font-medium">
                Brand
              </th>
              <th class="px-3 py-2 font-medium">
                Status
              </th>
              <th class="px-3 py-2 font-medium">
                Deal
              </th>
              <th class="px-3 py-2 text-right font-medium">
                Trybe score
              </th>
              <th class="px-3 py-2 text-right font-medium">
                Products
              </th>
              <th class="hidden px-3 py-2 font-medium lg:table-cell">
                Channels
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr
              v-for="brand in pageBrands"
              :key="brand.id"
              class="cursor-pointer hover:bg-elevated/50"
              @click="navigateTo(`/brands/${brand.id}`)"
            >
              <td class="px-1 py-2">
                <BrandStar :starred="brand.starred" :name="brand.name" @toggle="toggleStar(brand)" />
              </td>
              <td class="px-3 py-2">
                <NuxtLink :to="`/brands/${brand.id}`" class="flex min-w-0 items-center gap-2 font-medium text-highlighted" @click.stop>
                  <img
                    v-if="trybeLogo(brand)"
                    :src="trybeLogo(brand)!"
                    alt=""
                    class="size-5 shrink-0 rounded object-cover"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  >
                  <span class="truncate">{{ brand.name }}</span>
                </NuxtLink>
              </td>
              <td class="px-3 py-2">
                <UBadge v-if="brand.archived_at" label="Archived" color="neutral" variant="outline" />
                <UBadge v-else :label="brand.status" :color="BRAND_STATUS_COLORS[brand.status]" variant="subtle" class="capitalize" />
              </td>
              <td class="px-3 py-2 text-muted">
                {{ dealSummary(brand.deal) ?? '–' }}
              </td>
              <td class="px-3 py-2 text-right text-muted tabular-nums">
                {{ brand.trybe_score === null ? '–' : Number(brand.trybe_score) }}
              </td>
              <td class="px-3 py-2 text-right text-muted tabular-nums">
                {{ brand.products.length }}
              </td>
              <td class="hidden px-3 py-2 text-muted lg:table-cell">
                {{ brand.brand_channels.map(link => channelName(link.channel_id)).join(', ') || '–' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Board: a column per status; drag a card (or use its menu) to move the brand along -->
      <div v-else-if="view === 'board'" class="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        <section
          v-for="column in columns"
          :key="column.status"
          class="flex min-h-0 w-72 shrink-0 flex-col rounded-lg border border-default bg-elevated/30 transition"
          :class="{ 'ring-2 ring-primary': dropTarget === column.status }"
          @dragover.prevent="dropTarget = column.status"
          @drop.prevent="onDrop(column.status)"
        >
          <header class="flex shrink-0 items-center gap-2 border-b border-default px-3 py-2">
            <UBadge :label="column.status" :color="BRAND_STATUS_COLORS[column.status]" variant="subtle" class="capitalize" />
            <span class="text-xs text-muted tabular-nums">{{ column.all.length }}</span>
          </header>
          <div class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
            <div
              v-for="brand in column.shown"
              :key="brand.id"
              draggable="true"
              class="cursor-grab rounded-md border border-default bg-default p-2.5 shadow-xs active:cursor-grabbing"
              :class="{ 'opacity-50': dragging === brand.id }"
              @dragstart="onDragStart($event, brand)"
              @dragend="onDragEnd"
            >
              <div class="flex items-start gap-2">
                <NuxtLink :to="`/brands/${brand.id}`" class="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-highlighted hover:underline" draggable="false">
                  <img
                    v-if="trybeLogo(brand)"
                    :src="trybeLogo(brand)!"
                    alt=""
                    class="size-5 shrink-0 rounded object-cover"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    draggable="false"
                  >
                  <span class="truncate">{{ brand.name }}</span>
                </NuxtLink>
                <BrandStar :starred="brand.starred" :name="brand.name" @toggle="toggleStar(brand)" />
                <UDropdownMenu :items="moveItems(brand)" :content="{ align: 'end' }">
                  <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="`Move ${brand.name}`" />
                </UDropdownMenu>
              </div>
              <p class="mt-1 text-xs text-muted">
                {{ brand.products.length }} product{{ brand.products.length === 1 ? '' : 's' }}
                <template v-if="dealSummary(brand.deal)">
                  · {{ dealSummary(brand.deal) }}
                </template>
                <template v-if="brand.trybe_score !== null">
                  · score {{ Number(brand.trybe_score) }}
                </template>
              </p>
            </div>
            <p v-if="!column.all.length" class="py-6 text-center text-xs text-dimmed">
              No {{ column.status }} brands
            </p>
            <UButton
              v-if="column.all.length > column.shown.length"
              :label="`Show more (${column.all.length - column.shown.length} left)`"
              color="neutral"
              variant="ghost"
              size="xs"
              block
              @click="columnLimit[column.status] = column.shown.length + COLUMN_STEP"
            />
          </div>
        </section>
      </div>

      <p v-if="!filtered.length" class="py-12 text-center text-sm text-muted">
        {{ status === 'archived' && view !== 'board' ? 'No archived brands.' : brands.length ? 'No brands match.' : 'No brands yet. Create one to start planning shoots.' }}
      </p>
      <ListPager v-if="view !== 'board'" v-model:page="page" :total="filtered.length" :page-size="pageSize" class="mt-4" />

      <UModal :open="open" @update:open="requestOpen" title="New brand">
        <template #body>
          <div class="space-y-4">
            <UFormField label="Name" required>
              <UInput v-model="draft.name" class="w-full" autofocus />
            </UFormField>
            <UFormField label="Slug" help="Used in folder names. Can't change once set.">
              <UInput v-model="draft.slug" class="w-full" />
            </UFormField>
            <UFormField label="Status">
              <USelect v-model="draft.status" :items="selectOptions(BRAND_STATUSES)" class="w-full" />
            </UFormField>
            <USeparator label="Trybe deal" />
            <BrandDealFields v-model="deal" />
          </div>
        </template>
        <template #footer>
          <UButton label="Create brand" :loading="saving" :disabled="!draft.name.trim() || !draft.slug || !isValidUrl(deal.trybe_url)" @click="save" />
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
