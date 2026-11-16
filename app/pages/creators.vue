<script setup lang="ts">
import type { Row } from '#shared/types/models'

// A brand account's creators (restructure Phase 3): invite a creator by email to partner with the
// brand, and see who's invited, who's partnered and who's ended. A partnered creator gets the
// brand's profile, products and Library in their own account, kept in sync; their deal and channels
// stay theirs. Either side can end it: the creator keeps the shoots they made.
const db = useDb()
const run = useAction()
const toast = useToast()
const { confirmDialog } = useConfirm()
const { isAdmin } = useAccess()

const brand = ref<Pick<Row<'brands'>, 'id' | 'name'> | null>(null)
const partnerships = ref<Row<'partnerships'>[]>([])
async function load() {
  const [b, p] = await Promise.all([
    db.from('brands').select('id, name').is('source_brand_id', null).order('created_at').limit(1).maybeSingle(),
    db.from('partnerships').select('*').order('created_at', { ascending: false })
  ])
  brand.value = must(b)
  partnerships.value = must(p)
  // how many shoots each partnered creator has made for the brand (Results has the rest)
  if (brand.value) {
    const { data } = await db.rpc('partner_shoots', { p_brand_id: brand.value.id })
    shootCounts.value = (data ?? []).reduce((counts, row) => counts.set(row.creator_name, (counts.get(row.creator_name) ?? 0) + 1), new Map<string, number>())
  }
}
const shootCounts = ref(new Map<string, number>())
await load()

const groups = computed(() => [
  { title: 'Partnered', rows: partnerships.value.filter(row => row.status === 'active') },
  { title: 'Invited', rows: partnerships.value.filter(row => row.status === 'invited') },
  { title: 'Ended', rows: partnerships.value.filter(row => row.status === 'ended' || row.status === 'declined') }
].filter(group => group.rows.length))

const day = (value: string | null) => value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

// --- inviting ------------------------------------------------------------------
const email = ref('')
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
  if (!brand.value) return
  inviting.value = true
  const address = email.value.trim().toLowerCase()
  let id: string | null = null
  await run(async () => {
    const { data, error } = await db.rpc('invite_partner', { p_brand_id: brand.value!.id, p_email: address })
    if (error) throw error
    id = data
  })
  if (id && await send(id, true)) {
    toast.add({ title: `Invited ${address}`, description: 'We\'ve emailed them the invitation.', color: 'success' })
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
              They get {{ brand?.name ?? 'your brand' }}'s profile, products and Library in their own account, kept up to date as you change them. Their deal and their channels stay theirs.
            </p>
          </template>
          <form class="flex flex-wrap gap-2" @submit.prevent="invite">
            <UInput v-model="email" type="email" placeholder="creator@example.com" class="min-w-0 flex-1" />
            <UButton type="submit" label="Invite" icon="i-lucide-send" :loading="inviting" :disabled="!email.includes('@')" />
          </form>
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
