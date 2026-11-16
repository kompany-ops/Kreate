<script setup lang="ts">
import type { Row } from '#shared/types/models'
import type { PaidPlanId } from '#shared/utils/plans'

// Billing, in Settings → Profile (everyone else sees it at /billing): the org's plan, what it's
// using, and Klip. Every org is on a plan: Free until the owner chooses Starter, Pro (with a 30-day
// trial the first time) or Studio. The owner changes plan or cancels in Stripe's portal, buys extra
// team places, and buys Klip once (Studio includes it). Stripe tells the app through its webhook,
// so after checkout this waits for that to land.
const db = useDb()
const route = useRoute()
const toast = useToast()
const { isOwner, isAdmin } = useAccess()
const { currentOrg, load } = useOrg()
const { plan, loadPlan } = usePlan()

const subscription = ref<Row<'org_subscriptions'> | null>(null)
/** brands and agencies paying for this account's shoots for them (seats) */
const coveredBy = ref<string[]>([])
async function refresh() {
  const [{ data }, { data: seats }] = await Promise.all([
    db.from('org_subscriptions').select('*').maybeSingle(),
    db.from('seats').select('publisher_name, status').eq('status', 'active')
  ])
  subscription.value = data
  coveredBy.value = (seats ?? []).map(seat => seat.publisher_name)
  await Promise.all([load(), loadPlan()])
}
await refresh()

const STATUS: Record<string, { label: string, color: 'success' | 'warning' | 'error' | 'neutral' | 'info' }> = {
  trialing: { label: 'Free trial', color: 'info' },
  active: { label: 'Active', color: 'success' },
  past_due: { label: 'Payment failed: retrying', color: 'warning' },
  canceled: { label: 'Cancelled', color: 'neutral' },
  unpaid: { label: 'Unpaid', color: 'error' },
  incomplete: { label: 'Waiting for payment', color: 'warning' },
  incomplete_expired: { label: 'Checkout expired', color: 'neutral' },
  paused: { label: 'Paused', color: 'neutral' }
}
const live = computed(() => ['trialing', 'active', 'past_due'].includes(subscription.value?.status ?? ''))
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null
const current = computed(() => PLANS[plan.value?.plan ?? 'free'])
const exempt = computed(() => !!plan.value?.billing_exempt)

// what the plan includes, and what's used of it
const usage = computed(() => {
  const p = plan.value
  if (!p) return []
  return [
    { label: 'Team', used: p.team_used, limit: p.team_limit },
    { label: 'Cast', used: p.cast_used, limit: p.cast_limit },
    { label: 'Channels', used: p.channels_used, limit: p.channels_limit },
    { label: 'Brands', used: p.brands_used, limit: p.brands_limit },
    { label: 'Shoots this month', used: p.shoots_used, limit: p.shoots_limit }
  ]
})

// after checkout: wait for the webhook to sync the subscription (it usually beats the redirect, but not always)
const waiting = ref(false)
onMounted(async () => {
  if (route.query.checkout !== 'success' || live.value) return
  waiting.value = true
  for (let i = 0; i < 15 && !live.value; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    await refresh()
  }
  waiting.value = false
  if (live.value) toast.add({ title: `You're on ${current.value.title}`, color: 'success' })
  else toast.add({ title: 'Still waiting for Stripe', description: 'Your payment details went through. Refresh this page in a minute.', color: 'warning' })
})

// Sign Klip out everywhere (the team): licences issued before now aren't renewed
const { confirmDialog } = useConfirm()
const signingOutKlip = ref(false)
async function signOutKlip() {
  if (!(await confirmDialog({
    title: 'Sign Klip out everywhere?',
    description: `Everyone in ${currentOrg.value?.name ?? 'this organisation'} is signed out of Klip on every computer the next time it checks in (computers offline right now within 72 hours). Each one connects again with a new code from Kreate.`,
    confirmLabel: 'Sign out everywhere',
    danger: true
  }))) return
  signingOutKlip.value = true
  const { error } = await useSupabaseClient().rpc('sign_out_klip_everywhere')
  signingOutKlip.value = false
  toast.add(error
    ? { title: 'Couldn\'t sign Klip out', description: error.message, color: 'error' }
    : { title: 'Klip is signed out everywhere', description: 'Each computer connects again next time it\'s used.', color: 'success' })
}

// after buying Klip: the same wait, for the purchase
const klipOwned = computed(() => currentOrg.value?.klip_access === 'purchased')
const waitingKlip = ref(false)
onMounted(async () => {
  if (route.query.klip !== 'success' || klipOwned.value) return
  waitingKlip.value = true
  for (let i = 0; i < 15 && !klipOwned.value; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    await load()
  }
  waitingKlip.value = false
  if (klipOwned.value) toast.add({ title: 'Klip is yours', color: 'success' })
  else toast.add({ title: 'Still waiting for Stripe', description: 'Your payment went through. Refresh this page in a minute.', color: 'warning' })
})

const going = ref(false)
async function go(path: '/api/billing/checkout' | '/api/billing/portal' | '/api/billing/klip-checkout', body?: { plan: PaidPlanId }) {
  going.value = true
  try {
    const { url } = await $fetch<{ url: string | null }>(path, { method: 'POST', body })
    if (url) window.location.assign(url)
  } catch (error) {
    toast.add({ title: 'Couldn\'t open Stripe', description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? (error as Error).message, color: 'error' })
    going.value = false
  }
}

// extra team places (owner, on a paid plan)
const savingTeam = ref(false)
async function setExtraTeam(extra: number) {
  savingTeam.value = true
  try {
    await $fetch('/api/billing/team-seats', { method: 'POST', body: { extra } })
    await refresh()
  } catch (error) {
    toast.add({ title: 'Couldn\'t change team places', description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? (error as Error).message, color: 'error' })
  } finally {
    savingTeam.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <UCard :ui="{ body: 'space-y-4' }">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold text-highlighted">
          Kreate {{ current.title }}
        </h2>
        <UBadge v-if="exempt" label="Included" color="success" variant="subtle" />
        <UBadge v-else-if="live && subscription?.status" :label="STATUS[subscription.status]?.label ?? subscription.status" :color="STATUS[subscription.status]?.color ?? 'neutral'" variant="subtle" />
      </div>

      <p v-if="waiting" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Confirming your plan with Stripe…
      </p>
      <p v-else-if="exempt" class="text-sm text-muted">
        {{ currentOrg?.name }} uses Kreate without a subscription, with no limits.
      </p>
      <p v-else-if="live" class="text-sm text-muted">
        <template v-if="subscription?.status === 'trialing'">
          Your free trial ends {{ date(subscription.trial_end) }}, when the first payment of ${{ current.price }} is taken.
        </template>
        <template v-else-if="subscription?.cancel_at_period_end">
          Cancelled: it stays on {{ current.title }} until {{ date(subscription.current_period_end) }}, then moves to Free. Nothing is removed.
        </template>
        <template v-else>
          ${{ current.price }} a month<template v-if="plan?.extra_team">, plus {{ plan.extra_team }} extra team {{ plan.extra_team === 1 ? 'place' : 'places' }} at ${{ TEAM_MEMBER.price }} each</template>, renewing {{ date(subscription?.current_period_end) }}.
        </template>
      </p>
      <p v-else class="text-sm text-muted">
        You're on Free. Choose a plan when you need more: cast are always free, and you never lose anything by changing plan.
      </p>

      <p v-if="coveredBy.length" class="text-sm text-muted">
        <UIcon name="i-lucide-handshake" class="mr-1 align-middle" />
        {{ coveredBy.join(', ') }} {{ coveredBy.length === 1 ? 'pays' : 'pay' }} for your shoots for {{ coveredBy.length === 1 ? 'it' : 'them' }}: those don't use up your shoots a month, and Klip comes with {{ coveredBy.length === 1 ? 'it' : 'them' }}.
      </p>

      <!-- what's used of what the plan includes -->
      <div v-if="usage.length" class="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div v-for="row in usage" :key="row.label" class="rounded-lg border border-default p-3">
          <p class="text-xs text-muted">
            {{ row.label }}
          </p>
          <p class="text-lg font-semibold text-highlighted tabular-nums">
            {{ row.used }}<span class="text-sm font-normal text-muted"> / {{ limitLabel(row.limit) }}</span>
          </p>
        </div>
      </div>

      <!-- Free: choose a plan -->
      <div v-if="isOwner && !waiting && !exempt && !live" class="grid gap-3 sm:grid-cols-3">
        <div v-for="id in PAID_PLANS" :key="id" class="flex flex-col gap-2 rounded-lg border border-default p-4">
          <p class="font-semibold text-highlighted">
            {{ PLANS[id].title }}
            <span class="font-normal text-muted">${{ PLANS[id].price }}/mo</span>
          </p>
          <p class="flex-1 text-sm text-muted">
            {{ PLANS[id].description }}
          </p>
          <UButton
            :label="PLANS[id].trial && !subscription?.trial_used ? 'Start 30-day free trial' : `Choose ${PLANS[id].title}`"
            :variant="id === 'pro' ? 'solid' : 'outline'"
            :color="id === 'pro' ? 'primary' : 'neutral'"
            block
            :loading="going"
            @click="go('/api/billing/checkout', { plan: id })"
          />
        </div>
      </div>

      <div v-if="isOwner && !waiting && live" class="flex flex-wrap items-center gap-2">
        <UButton
          label="Change plan or manage billing"
          icon="i-lucide-external-link"
          color="neutral"
          variant="subtle"
          :loading="going"
          @click="go('/api/billing/portal')"
        />
      </div>

      <!-- extra team places, on a paid plan -->
      <div v-if="isOwner && live && plan" class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
        <p class="min-w-0 flex-1 text-sm text-muted">
          {{ current.title }} includes {{ current.limits.team }} on the team (you included). Extra team places are ${{ TEAM_MEMBER.price }} a month each.
        </p>
        <div class="flex items-center gap-2">
          <UButton icon="i-lucide-minus" color="neutral" variant="outline" aria-label="One fewer team place" :disabled="!plan.extra_team || savingTeam" @click="setExtraTeam(plan.extra_team - 1)" />
          <span class="w-20 text-center text-sm tabular-nums">{{ plan.extra_team }} extra</span>
          <UButton icon="i-lucide-plus" color="neutral" variant="outline" aria-label="One more team place" :loading="savingTeam" @click="setExtraTeam(plan.extra_team + 1)" />
        </div>
      </div>

      <p v-else-if="!isOwner && !exempt" class="text-sm text-muted">
        The owner of {{ currentOrg?.name }} chooses and changes its plan.
      </p>
    </UCard>
    <UCard :ui="{ body: 'space-y-4' }">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold text-highlighted">
          Klip
        </h2>
        <UBadge v-if="klipOwned" label="Owned" color="success" variant="subtle" />
        <UBadge v-else-if="currentOrg?.klip_access === 'exempt' || currentOrg?.klip_access === 'included' || currentOrg?.klip_access === 'seat'" label="Included" color="success" variant="subtle" />
        <UBadge v-else-if="currentOrg?.klip_access === 'trial'" label="In your trial" color="info" variant="subtle" />
        <UBadge v-else label="Not bought" color="neutral" variant="subtle" />
      </div>

      <p v-if="waitingKlip" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Confirming your purchase with Stripe…
      </p>
      <p v-else class="text-sm text-muted">
        The desktop editor for your shoots' clips: trims, captions and treatments.
        <template v-if="klipOwned">
          {{ currentOrg?.name }} owns it.
        </template>
        <template v-else-if="currentOrg?.klip_access === 'exempt'">
          {{ currentOrg?.name }} uses it without buying it.
        </template>
        <template v-else-if="currentOrg?.klip_access === 'included'">
          Studio includes it.
        </template>
        <template v-else-if="currentOrg?.klip_access === 'seat'">
          {{ coveredBy.join(', ') || 'A brand you partner with' }} {{ coveredBy.length > 1 ? 'include' : 'includes' }} it while {{ coveredBy.length > 1 ? 'they pay' : 'it pays' }} for your shoots.
        </template>
        <template v-else-if="currentOrg?.klip_access === 'trial'">
          Your free trial includes it until {{ date(subscription?.trial_end) ?? 'the trial ends' }}. To keep it after that, buy it once for $189.99.
        </template>
        <template v-else>
          $189.99 once for your account, on any plan. Studio includes it.
        </template>
      </p>

      <div v-if="isOwner && !waitingKlip && !klipOwned && !['exempt', 'included', 'seat'].includes(currentOrg?.klip_access ?? '')">
        <UButton label="Buy Klip" icon="i-lucide-scissors" :loading="going" @click="go('/api/billing/klip-checkout')" />
      </div>

      <!-- like "sign out of all devices": every computer has to connect Klip again -->
      <div v-if="isAdmin" class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
        <p class="min-w-0 flex-1 text-sm text-muted">
          Sign everyone in {{ currentOrg?.name }} out of Klip on every computer. Each one connects again with a new code.
        </p>
        <UButton label="Sign Klip out everywhere" icon="i-lucide-log-out" color="neutral" variant="outline" :loading="signingOutKlip" @click="signOutKlip" />
      </div>
    </UCard>
    <p class="text-xs text-dimmed">
      Payments are handled by Stripe, which also handles sales tax and receipts.
    </p>
  </div>
</template>
