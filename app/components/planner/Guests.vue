<script setup lang="ts">
import type { Row } from '#shared/types/models'

// Guests on a shoot (restructure Phase 7): the team invites someone from outside the account onto
// this shoot, on one of its channels. They film and upload their takes here and see nothing else of
// the account; they don't count toward the plan's cast. Invite them while the shoot is a draft, so
// their shots can be planned.
const props = defineProps<{
  shootId: string
  shootCode: string
  /** the shoot's channels: a guest films for one of them */
  channels: { id: string, name: string }[]
  draft: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const db = useDb()
const run = useAction()
const toast = useToast()
const { confirmDialog } = useConfirm()

type Guest = Row<'org_members'> & { profile: { email: string | null, full_name: string | null } | null }
const guests = ref<Guest[]>([])
const invites = ref<Row<'org_invites'>[]>([])
async function load() {
  const [m, i] = await Promise.all([
    db.from('org_members').select('*, profile:profiles(email, full_name)').contains('shoot_ids', [props.shootId]),
    db.from('org_invites').select('*').contains('shoot_ids', [props.shootId])
  ])
  guests.value = must(m) as Guest[]
  invites.value = must(i)
}
await load()

const open = ref(false)
const form = reactive({ email: '', name: '', channel: '' })
function start() {
  Object.assign(form, { email: '', name: '', channel: props.channels[0]?.id ?? '' })
  open.value = true
}
const saving = ref(false)
async function invite() {
  saving.value = true
  const email = form.email.trim().toLowerCase()
  const ok = await run(async () => {
    must(await db.from('org_invites').insert({
      email, role: 'cast', display_name: form.name.trim() || null,
      shoot_ids: [props.shootId], channel_ids: form.channel ? [form.channel] : []
    }))
  })
  saving.value = false
  if (!ok) return
  open.value = false
  try {
    await $fetch('/api/invites/send', { method: 'POST', body: { email } })
    toast.add({ title: `Invited ${email} to ${props.shootCode}`, description: 'We\'ve emailed them the invite.', color: 'success' })
  } catch (failure) {
    toast.add({ title: 'The invite is saved, but the email didn\'t go', description: (failure as { data?: { statusMessage?: string } }).data?.statusMessage, color: 'warning' })
  }
  await load()
  emit('changed')
}

async function remove(guest: Guest) {
  if (!(await confirmDialog({
    title: `Remove ${guest.display_name ?? guest.profile?.email ?? 'this guest'}?`,
    description: 'They lose access straight away. What they filmed stays on the shoot.',
    confirmLabel: 'Remove',
    danger: true
  }))) return
  await run(async () => {
    const person = must(await db.from('people').select('id').eq('user_id', guest.user_id).maybeSingle())
    if (person) {
      must(await db.from('person_channels').delete().eq('person_id', person.id))
      must(await db.from('people').update({ active: false }).eq('id', person.id))
    }
    must(await db.from('org_members').delete().eq('user_id', guest.user_id))
    await load()
    emit('changed')
  }, 'Guest removed')
}
async function withdraw(row: Row<'org_invites'>) {
  await run(async () => {
    must(await db.from('org_invites').delete().eq('email', row.email))
    await load()
  }, 'Invite withdrawn')
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-medium text-highlighted">
        Guests
      </p>
      <UButton v-if="draft" label="Invite a guest" icon="i-lucide-user-plus" size="xs" color="neutral" variant="outline" @click="start" />
    </div>
    <p v-if="!guests.length && !invites.length" class="text-xs text-muted">
      Someone from outside your account, on just this shoot: they film their takes and see nothing else.
    </p>
    <div v-for="guest in guests" :key="guest.user_id" class="flex items-center gap-2 text-sm">
      <span class="min-w-0 flex-1 truncate">{{ guest.display_name ?? guest.profile?.full_name ?? guest.profile?.email }}</span>
      <UBadge label="Guest" color="neutral" variant="subtle" size="sm" />
      <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove guest" @click="remove(guest)" />
    </div>
    <div v-for="row in invites" :key="row.email" class="flex items-center gap-2 text-sm">
      <span class="min-w-0 flex-1 truncate text-muted">{{ row.email }}</span>
      <UBadge label="Invited" color="warning" variant="subtle" size="sm" />
      <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Withdraw invite" @click="withdraw(row)" />
    </div>

    <UModal v-model:open="open" :title="`Invite a guest to ${shootCode}`">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Email" required help="They sign in or create a free account with it, and join this shoot.">
            <UInput v-model="form.email" type="email" class="w-full" />
          </UFormField>
          <UFormField label="Name" help="How they show on the shot list">
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <UFormField label="Channel" help="Which of the shoot's channels they film for">
            <USelect v-model="form.channel" :items="channels.map(channel => ({ label: channel.name, value: channel.id }))" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton label="Invite" icon="i-lucide-send" :loading="saving" :disabled="!form.email.includes('@')" @click="invite" />
      </template>
    </UModal>
  </div>
</template>
