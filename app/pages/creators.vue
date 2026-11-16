<script setup lang="ts">
import type { Row } from '#shared/types/models'

// A brand account's creators (restructure Phase 3): invite a creator by email to partner with the
// brand, and see who's invited, who's partnered and who's ended. A partnered creator gets the
// brand's profile, products and Library in their own account, kept in sync; their deal and channels
// stay theirs. Either side can end it: the creator keeps the shoots they made. The owner can pay for
// a partnered creator's shoots with a seat (Phase 5): their shoots for the brand skip their plan's
// limit, and they get Klip.
const db = useDb()
const run = useAction()
const toast = useToast()
const { confirmDialog } = useConfirm()
const { isAdmin, isOwner, access } = useAccess()
const route = useRoute()

/** an agency runs several brands; a brand account has one */
const agency = computed(() => access.value?.kind === 'agency')
const ownBrands = ref<Pick<Row<'brands'>, 'id' | 'name'>[]>([])
const brand = computed(() => ownBrands.value[0] ?? null)
const partnerships = ref<Row<'partnerships'>[]>([])
async function load() {
  const [b, p] = await Promise.all([
    db.from('brands').select('id, name').is('source_brand_id', null).is('archived_at', null).order('name'),
    db.from('partnerships').select('*').order('created_at', { ascending: false })
  ])
  ownBrands.value = must(b)
  partnerships.value = must(p)
  const [st, sub] = await Promise.all([
    db.from('seats').select('*').neq('status', 'ended'),
    db.from('org_subscriptions').select('status, seats').maybeSingle()
  ])
  seats.value = must(st)
  subscription.value = sub.data
  // how many shoots each partnered creator has made for the brand(s) (Results has the rest)
  const counts = new Map<string, number>()
  for (const own of ownBrands.value) {
    const { data } = await db.rpc('partner_shoots', { p_brand_id: own.id })
    for (const row of data ?? []) counts.set(row.creator_name, (counts.get(row.creator_name) ?? 0) + 1)
  }
  shootCounts.value = counts
}
const shootCounts = ref(new Map<string, number>())
const seats = ref<Row<'seats'>[]>([])
const subscription = ref<{ status: string | null, seats: number } | null>(null)
await load()

// --- seats -----------------------------------------------------------------------
const seatKind = computed<SeatKind>(() => access.value?.kind === 'agency' ? 'agency' : 'brand')
const seatOf = (creatorOrgId: string | null) => seats.value.find(seat => seat.creator_org_id === creatorOrgId) ?? null
/** a seat is per creator account: an agency's creator partnered on several brands shows it once */
const firstActiveFor = (row: Row<'partnerships'>) =>
  partnerships.value.find(other => other.status === 'active' && other.creator_org_id === row.creator_org_id)?.id === row.id
const billingLive = computed(() => ['trialing', 'active', 'past_due'].includes(subscription.value?.status ?? ''))
/** the price of the next seat, at the step the current count is on */
const nextSeatPrice = computed(() => seatsTotal(seatKind.value, seats.value.length + 1) - seatsTotal(seatKind.value, seats.value.length))
const savingSeat = ref<string | null>(null)
async function setSeat(creatorOrgId: string, on: boolean, name: string) {
  if (!on && !(await confirmDialog({
    title: `Stop paying for ${name}'s shoots?`,
    description: 'From now, their shoots for you count toward their own plan again, and Klip goes unless they have it otherwise. Nothing they\'ve made is removed.',
    confirmLabel: 'Stop paying',
    danger: true
  }))) return
  savingSeat.value = creatorOrgId
  try {
    const { url } = await $fetch<{ url: string | null }>('/api/billing/seats', { method: 'POST', body: { creatorOrgId, on } })
    if (url) {
      window.location.assign(url)
      return
    }
    await load()
    toast.add({ title: on ? `You're paying for ${name}'s shoots` : `You've stopped paying for ${name}'s shoots`, color: 'success' })
  } catch (error) {
    toast.add({ title: 'Couldn\'t change the seat', description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? (error as Error).message, color: 'error' })
  } finally {
    savingSeat.value = null
  }
}
// back from Checkout: wait for the webhook to start the seats
onMounted(async () => {
  if (route.query.seats !== 'success') return
  for (let i = 0; i < 10 && seats.value.some(seat => seat.status === 'pending'); i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    await load()
  }
})
async function manageBilling() {
  const { url } = await $fetch<{ url: string | null }>('/api/billing/portal', { method: 'POST' })
  if (url) window.location.assign(url)
}

const groups = computed(() => [
  { title: 'Partnered', rows: partnerships.value.filter(row => row.status === 'active') },
  { title: 'Invited', rows: partnerships.value.filter(row => row.status === 'invited') },
  { title: 'Ended', rows: partnerships.value.filter(row => row.status === 'ended' || row.status === 'declined') }
].filter(group => group.rows.length))

const day = (value: string | null) => value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

// --- inviting ------------------------------------------------------------------
const email = ref('')
const inviteBrands = ref<string[]>([])
watch(ownBrands, (list) => {
  if (!inviteBrands.value.length && list[0]) inviteBrands.value = [list[0].id]
}, { immediate: true })
const inviting = ref(false)
async function send(id: string, quiet = false) {
  try {
    await $fetch('/api/partnerships/send', { method: 'POST', body: { id } })
    if (!quiet) toast.add({ title: 'Invitation emailed', color: 'success' })
    return true
  } catch (failure) {
    toast.add({ title: 'The invitation is saved, but the email didn\'t go', description: (failure as { data?: { statusMessage?: string } }).data?.statusMessage, color: 'warning' })
    return false
  } finally {
    await load()
  }
}
async function invite() {
  const brandIds = agency.value ? inviteBrands.value : brand.value ? [brand.value.id] : []
  if (!brandIds.length) return
  inviting.value = true
  const address = email.value.trim().toLowerCase()
  const ids: string[] = []
  await run(async () => {
    // one partnership per brand, each its own invitation
    for (const brandId of brandIds) {
      const { data, error } = await db.rpc('invite_partner', { p_brand_id: brandId, p_email: address })
      if (error) throw error
      ids.push(data)
    }
  })
  let emailed = 0
  for (const id of ids) if (await send(id, true)) emailed++
  if (ids.length && emailed === ids.length) {
    toast.add({ title: `Invited ${address}`, description: ids.length > 1 ? `To ${ids.length} brands: we've emailed them each invitation.` : 'We\'ve emailed them the invitation.', color: 'success' })
    email.value = ''
  }
  inviting.value = false
}

// --- ending --------------------------------------------------------------------
async function end(row: Row<'partnerships'>) {
  const pending = row.status === 'invited'
  if (!(await confirmDialog({
    title: pending ? `Withdraw the invitation to ${row.invited_email}?` : `End the partnership with ${row.creator_name ?? row.invited_email}?`,
    description: pending
      ? 'They won\'t be able to accept it. You can invite them again later.'
      : `${brand.value?.name ?? 'Your brand'} is archived in their account: no new shoots for it. The shoots they've made stay theirs.`,
    confirmLabel: pending ? 'Withdraw' : 'End partnership',
    danger: true
  }))) return
  await run(async () => {
    const { error } = await db.rpc('end_partnership', { p_id: row.id })
    if (error) throw error
    await load()
  }, pending ? 'Invitation withdrawn' : 'Partnership ended')
}
</script>

<template>
  <UDashboardPanel id="creators">
    <template #header>
      <UDashboardNavbar title="Creators">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-3xl space-y-6">
        <UCard v-if="isAdmin">
          <template #header>
            <h2 class="font-semibold text-highlighted">
              Invite a creator
            </h2>
            <p class="text-sm text-muted">
              They get {{ agency ? 'each brand you choose, with its profile, products and Library, and your own Library,' : `${brand?.name ?? 'your brand'}'s profile, products and Library` }} in their own account, kept up to date as you change them. Their deal and their channels stay theirs.
            </p>
          </template>
          <form class="flex flex-wrap gap-2" @submit.prevent="invite">
            <UInput v-model="email" type="email" placeholder="creator@example.com" class="min-w-0 flex-1" />
            <USelectMenu
              v-if="agency"
              v-model="inviteBrands"
              :items="ownBrands.map(own => ({ label: own.name, value: own.id }))"
              value-key="value"
              multiple
              placeholder="Which brands?"
              class="w-56"
            />
            <UButton type="submit" label="Invite" icon="i-lucide-send" :loading="inviting" :disabled="!email.includes('@') || (agency && !inviteBrands.length)" />
          </form>
        </UCard>

        <UCard v-if="isAdmin && (seats.length || partnerships.some(row => row.status === 'active'))">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="font-semibold text-highlighted">
                Seats
              </h2>
              <p class="text-sm text-muted">
                Pay for a creator's shoots for you: they skip their plan's limit on them, and get Klip.
                {{ seats.length }} seat{{ seats.length === 1 ? '' : 's' }}, ${{ seatsTotal(seatKind, seats.length).toFixed(2) }} a month.
                The next is ${{ nextSeatPrice.toFixed(2) }}: seats cost less from 10, 25 and 50.
              </p>
            </div>
            <UButton v-if="isOwner && subscription" label="Manage billing" icon="i-lucide-external-link" color="neutral" variant="subtle" size="sm" @click="manageBilling" />
          </div>
          <p v-if="seats.some(seat => seat.status === 'pending')" class="mt-2 text-sm text-warning">
            {{ billingLive ? 'Starting the new seats…' : 'Waiting for checkout to go through before the seats start.' }}
          </p>
        </UCard>

        <div v-for="group in groups" :key="group.title" class="space-y-2">
          <h2 class="text-sm font-medium text-muted">
            {{ group.title }} · {{ group.rows.length }}
          </h2>
          <div class="divide-y divide-default rounded-lg border border-default">
            <div v-for="row in group.rows" :key="row.id" class="flex flex-wrap items-center gap-3 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-highlighted">
                  {{ row.creator_name ?? row.invited_email }}
                  <span v-if="agency" class="font-normal text-muted">· {{ row.brand_name }}</span>
                </p>
                <p class="text-sm text-muted">
                  <template v-if="row.status === 'active'">
                    {{ row.invited_email }} · partnered {{ day(row.accepted_at) }} ·
                    <NuxtLink :to="{ path: '/results', query: { creator: row.creator_name ?? undefined } }" class="text-highlighted hover:underline">
                      {{ shootCounts.get(row.creator_name ?? '') ?? 0 }} shoot{{ shootCounts.get(row.creator_name ?? '') === 1 ? '' : 's' }}
                    </NuxtLink>
                  </template>
                  <template v-else-if="row.status === 'invited'">
                    Invited {{ day(row.created_at) }}{{ row.emailed_at ? `, emailed ${day(row.emailed_at)}` : ', not emailed yet' }}
                  </template>
                  <template v-else>
                    {{ row.status === 'declined' ? 'Declined' : 'Ended' }} {{ day(row.ended_at) }}
                  </template>
                </p>
              </div>
              <template v-if="row.status === 'active' && row.creator_org_id && firstActiveFor(row)">
                <UBadge v-if="seatOf(row.creator_org_id)?.status === 'pending'" label="Seat pending" color="warning" variant="subtle" size="sm" />
                <USwitch
                  :model-value="!!seatOf(row.creator_org_id)"
                  :disabled="!isOwner || savingSeat === row.creator_org_id"
                  label="Pay for their shoots"
                  size="sm"
                  @update:model-value="setSeat(row.creator_org_id!, $event, row.creator_name ?? row.invited_email)"
                />
              </template>
              <template v-if="isAdmin">
                <UButton
                  v-if="row.status === 'invited'"
                  :label="row.emailed_at ? 'Resend' : 'Email it'"
                  icon="i-lucide-send"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  @click="send(row.id)"
                />
                <UButton
                  v-if="row.status === 'invited' || row.status === 'active'"
                  :label="row.status === 'invited' ? 'Withdraw' : 'End'"
                  size="sm"
                  color="error"
                  variant="ghost"
                  @click="end(row)"
                />
              </template>
            </div>
          </div>
        </div>

        <p v-if="!partnerships.length" class="py-8 text-center text-sm text-muted">
          No creators yet. Invite one above: they'll find your invitation on their Brands page.
        </p>
      </div>
    </template>
  </UDashboardPanel>
</template>
