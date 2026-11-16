<script setup lang="ts">
// An agency account's plan, in Settings → Profile (restructure Phase 6): $99 a month for many brands,
// a roster and its own Library, and needed before inviting creators. Seats for creators are on the
// Creators page and go on the same subscription. The owner starts it (Checkout) and manages it in
// Stripe's portal; the webhook records it.
import type { Row } from '#shared/types/models'

const db = useDb()
const route = useRoute()
const toast = useToast()
const { isOwner } = useAccess()
const { currentOrg } = useOrg()

const subscription = ref<Pick<Row<'org_subscriptions'>, 'status' | 'plan' | 'seats' | 'current_period_end' | 'cancel_at_period_end'> | null>(null)
async function refresh() {
  const { data } = await db.from('org_subscriptions').select('status, plan, seats, current_period_end, cancel_at_period_end').maybeSingle()
  subscription.value = data
}
await refresh()
const exempt = computed(() => currentOrg.value?.klip_access === 'exempt')
const live = computed(() => exempt.value || (subscription.value?.plan === 'agency' && ['trialing', 'active', 'past_due'].includes(subscription.value?.status ?? '')))
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null

// back from Checkout: wait for the webhook
onMounted(async () => {
  if (route.query.checkout !== 'success' || live.value) return
  for (let i = 0; i < 10 && !live.value; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    await refresh()
  }
  if (live.value) toast.add({ title: 'The agency plan is on: you can invite creators', color: 'success' })
})

const going = ref(false)
async function go(path: '/api/billing/checkout' | '/api/billing/portal') {
  going.value = true
  try {
    const { url } = await $fetch<{ url: string | null }>(path, { method: 'POST', body: path.endsWith('checkout') ? { plan: 'agency' } : undefined })
    if (url) window.location.assign(url)
  } catch (error) {
    toast.add({ title: 'Couldn\'t open Stripe', description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? (error as Error).message, color: 'error' })
    going.value = false
  }
}
</script>

<template>
  <UCard :ui="{ body: 'space-y-3' }">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-semibold text-highlighted">
        Agency plan
      </h2>
      <UBadge v-if="live" :label="exempt ? 'Included' : 'Active'" color="success" variant="subtle" />
      <UBadge v-else label="Not started" color="neutral" variant="subtle" />
    </div>
    <p class="text-sm text-muted">
      <template v-if="exempt">
        {{ currentOrg?.name }} uses Kreate without a subscription.
      </template>
      <template v-else-if="live">
        ${{ AGENCY_PLAN.price }} a month<template v-if="subscription?.seats">, plus {{ subscription.seats }} seat{{ subscription.seats === 1 ? '' : 's' }} for creators</template>,
        {{ subscription?.cancel_at_period_end ? `ending ${date(subscription.current_period_end)}` : `renewing ${date(subscription?.current_period_end)}` }}.
      </template>
      <template v-else>
        ${{ AGENCY_PLAN.price }} a month for all your brands, your roster and your own Library. Start it to invite creators.
      </template>
    </p>
    <div v-if="isOwner && !exempt" class="flex flex-wrap gap-2">
      <UButton v-if="!live" label="Start the agency plan" icon="i-lucide-credit-card" :loading="going" @click="go('/api/billing/checkout')" />
      <UButton v-if="subscription" label="Manage billing" icon="i-lucide-external-link" color="neutral" variant="subtle" :loading="going" @click="go('/api/billing/portal')" />
    </div>
    <p v-else-if="!isOwner" class="text-sm text-muted">
      The owner of {{ currentOrg?.name }} starts and manages the plan.
    </p>
  </UCard>
</template>
