<script setup lang="ts">
// Start / end a shoot on set: planned -> shooting -> filmed. Admins only; the database enforces it
// and records who started and ended it, and when. Ending with shots still unticked asks first, and an ended
// shoot with shots still unticked can be resumed. A shoot can't end until Dropbox is connected: ending is what
// opens the upload, and clips only ever go to Dropbox (the database refuses it too).
const props = defineProps<{
  shoot: { id: string, status: string }
  /** items and b-roll shots not yet filmed or skipped */
  remaining: number
  size?: 'sm' | 'md'
  /** show icons only on phones */
  iconOnMobile?: boolean
  /** the page offers Resume in its own menu (the shoot page's Actions) */
  noResume?: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const db = useDb()
const toast = useToast()
const dropbox = useDropbox()
const { isAdmin } = useAccess()
const run = useAction()
const busy = ref(false)
const confirmingEnd = ref(false)

async function setStatus(status: 'shooting' | 'filmed', message: string) {
  busy.value = true
  const ok = await run(async () => {
    must(await db.from('shoots').update({ status }).eq('id', props.shoot.id))
  }, message)
  busy.value = false
  confirmingEnd.value = false
  if (ok) emit('changed')
}

const resume = () => setStatus('shooting', 'Shoot resumed')

/** Dropbox has to be connected before a shoot can end (and is checked when it starts, so nobody finds out at the end). */
async function dropboxReady(action: 'start' | 'end') {
  const status = await dropbox.refresh().catch(() => null)
  if (status?.connected) return true
  toast.add({
    title: action === 'end' ? 'Connect Dropbox before ending the shoot' : 'Dropbox isn\'t connected',
    description: action === 'end'
      ? 'Clips upload to Dropbox once the shoot ends. Connect it in Settings → Dropbox; the clips stay on each phone until then.'
      : 'You can film, but the shoot can\'t end (and clips can\'t upload) until it\'s connected in Settings → Dropbox.',
    color: action === 'end' ? 'error' : 'warning',
    icon: 'i-lucide-cloud-off',
    duration: 10000,
    actions: [{ label: 'Settings', onClick: () => { navigateTo('/settings?tab=dropbox') } }]
  })
  return false
}

async function start() {
  await dropboxReady('start')
  await setStatus('shooting', 'Shoot started')
}

async function end() {
  if (!(await dropboxReady('end'))) return
  if (props.remaining > 0) confirmingEnd.value = true
  else setStatus('filmed', 'Shoot ended')
}

defineExpose({ start, end, resume })

const compact = computed(() => props.iconOnMobile ? { ui: ICON_ON_MOBILE, class: 'max-sm:px-1.5' } : {})
</script>

<template>
  <UButton
    v-if="isAdmin && props.shoot.status === 'planned'"
    label="Start shoot"
    aria-label="Start shoot"
    v-bind="compact"
    icon="i-lucide-play"
    color="success"
    :size="props.size"
    :loading="busy"
    @click="start"
  />
  <UButton
    v-else-if="isAdmin && props.shoot.status === 'shooting'"
    label="End shoot"
    aria-label="End shoot"
    v-bind="compact"
    icon="i-lucide-square"
    color="error"
    :size="props.size"
    :loading="busy"
    @click="end"
  />
  <UButton
    v-else-if="isAdmin && !props.noResume && props.shoot.status === 'filmed' && props.remaining > 0"
    label="Resume shoot"
    aria-label="Resume shoot"
    v-bind="compact"
    icon="i-lucide-rotate-ccw"
    color="success"
    variant="subtle"
    :size="props.size"
    :loading="busy"
    @click="resume"
  />

  <UModal v-model:open="confirmingEnd" title="End the shoot?">
    <template #body>
      <p class="text-sm text-default">
        {{ props.remaining }} shot{{ props.remaining === 1 ? ' is' : 's are' }} not ticked off or skipped yet.
      </p>
      <p class="mt-2 text-sm text-muted">
        Ending marks the shoot as filmed. You can still tick shots off afterwards.
      </p>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full justify-end gap-2">
        <UButton label="Keep shooting" color="neutral" variant="ghost" @click="close" />
        <UButton label="End shoot" icon="i-lucide-square" color="error" :loading="busy" @click="setStatus('filmed', 'Shoot ended')" />
      </div>
    </template>
  </UModal>
</template>
