<script setup lang="ts">
import type { KitColor, KitFont, KitLogo } from '#shared/utils/statics'

// A brand's design kit for static ads (docs/spec-statics.md §3): colours, fonts, logos, style notes
// and rules Kanvas applies on top of every static format's. Packshots go in the brand's Dropbox
// _kit/packshots/ folder. Collapsed until opened; the team edits it, everyone else reads it.
const props = defineProps<{ brand: { id: string, org_id: string, name: string } }>()

const db = useDb()
const run = useAction()
const { isAdmin } = useAccess()

const open = ref(false)
const loaded = ref(false)
const saving = ref(false)
const kit = reactive({
  colors: [] as KitColor[],
  fonts: [] as (KitFont & { uploading?: boolean })[],
  logos: [] as KitLogo[],
  style_notes: '',
  always: '',
  never: '',
  dropbox_path: null as string | null
})
const empty = computed(() => !kit.colors.length && !kit.fonts.length && !kit.logos.length && !kit.style_notes && !kit.always && !kit.never)
const links = ref<Record<string, string>>({})

async function load() {
  const row = must(await db.from('brand_kits').select('*').eq('brand_id', props.brand.id).maybeSingle())
  const parsed = parseBrandKit(row)
  Object.assign(kit, {
    colors: parsed.colors,
    fonts: parsed.fonts,
    logos: parsed.logos,
    style_notes: parsed.style_notes ?? '',
    always: parsed.rules.always.join('\n'),
    never: parsed.rules.never.join('\n'),
    dropbox_path: parsed.dropbox_path
  })
  const paths = parsed.logos.map(logo => logo.path)
  links.value = paths.length ? await signedBrandKitFiles(db, paths).catch(() => ({})) : {}
  loaded.value = true
}
run(load)

// --- files -------------------------------------------------------------------------------------
const logoPicker = useTemplateRef<HTMLInputElement>('logoPicker')
const fontPicker = useTemplateRef<HTMLInputElement>('fontPicker')
const fontFor = ref<number | null>(null)
async function onLogo(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  await run(async () => {
    for (const file of files) {
      const path = await uploadBrandKitFile(db, props.brand, 'logos', file, file.name)
      kit.logos.push({ path, use: kit.logos.length ? 'dark' : 'light' })
      links.value = { ...links.value, ...await signedBrandKitFiles(db, [path]) }
    }
  })
}
async function onFont(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const font = fontFor.value === null ? null : kit.fonts[fontFor.value]
  if (!file || !font) return
  await run(async () => {
    font.uploading = true
    try {
      font.file = await uploadBrandKitFile(db, props.brand, 'fonts', file, file.name)
      if (!font.family.trim()) font.family = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
    } finally {
      font.uploading = false
    }
  })
}
function pickFont(index: number) {
  fontFor.value = index
  fontPicker.value?.click()
}
const freeRole = computed(() => KIT_FONT_ROLES.find(role => !kit.fonts.some(font => font.role === role)))

const fileName = (path: string) => path.split('/').pop() ?? path
const LOGO_USES = [
  { label: 'On light', value: 'light' },
  { label: 'On dark', value: 'dark' },
  { label: 'Mark', value: 'mark' }
]
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean)
const problem = computed(() => {
  try {
    cleanKitColors(kit.colors)
    cleanKitFonts(kit.fonts)
    return null
  } catch (error) {
    return (error as Error).message
  }
})

async function save() {
  saving.value = true
  await run(async () => {
    await saveBrandKit(db, props.brand.id, {
      colors: kit.colors,
      fonts: kit.fonts.map(({ role, family, file }) => ({ role, family, file })),
      logos: kit.logos,
      style_notes: kit.style_notes,
      rules: { always: lines(kit.always), never: lines(kit.never) }
    })
    await load()
  }, 'Design kit saved')
  saving.value = false
}

const dropboxLink = computed(() => kit.dropbox_path ? `https://www.dropbox.com/home${encodeURI(kit.dropbox_path)}` : null)
</script>

<template>
  <UCard :ui="{ body: open ? undefined : 'hidden', footer: open && isAdmin ? undefined : 'hidden' }">
    <template #header>
      <button type="button" class="flex w-full items-center gap-2 text-left" :aria-expanded="open" @click="open = !open">
        <UIcon name="i-lucide-chevron-right" class="size-4 text-muted transition-transform" :class="{ 'rotate-90': open }" />
        <div class="min-w-0 flex-1">
          <h2 class="font-semibold text-highlighted">
            Design kit
          </h2>
          <p class="text-sm text-muted">
            Colours, fonts and logos for its static ads.
          </p>
        </div>
        <span v-if="loaded && !open" class="flex shrink-0 items-center gap-1">
          <span v-for="color in kit.colors.slice(0, 5)" :key="color.hex + color.name" class="size-4 rounded-full border border-default" :style="{ background: color.hex }" />
          <UBadge v-if="empty" label="No kit" color="neutral" variant="subtle" size="sm" />
        </span>
      </button>
    </template>

    <fieldset :disabled="!isAdmin" class="space-y-5">
      <p v-if="empty && !isAdmin" class="text-sm text-muted">
        No design kit yet: Kanvas takes the look from each format's example ads and the product stills.
      </p>

      <UFormField label="Colours">
        <div class="space-y-2">
          <div v-for="(color, index) in kit.colors" :key="index" class="flex items-center gap-2">
            <input
              type="color"
              :value="kitHex(color.hex) ?? '#000000'"
              class="size-9 shrink-0 cursor-pointer rounded border border-default bg-transparent p-0.5"
              :aria-label="`${color.name || 'Colour'} picker`"
              @input="color.hex = ($event.target as HTMLInputElement).value"
            >
            <UInput v-model="color.hex" placeholder="#ff6600" class="w-28 font-mono" aria-label="Hex code" />
            <UInput v-model="color.name" placeholder="Primary" class="min-w-0 flex-1" aria-label="Name" />
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove colour" @click="kit.colors.splice(index, 1)" />
          </div>
          <UButton v-if="isAdmin" label="Add a colour" icon="i-lucide-plus" size="sm" color="neutral" variant="subtle" @click="kit.colors.push({ name: '', hex: '' })" />
        </div>
      </UFormField>

      <UFormField label="Fonts" help="By family name, or upload the font file for formats that set text over the image">
        <div class="space-y-2">
          <div v-for="(font, index) in kit.fonts" :key="index" class="flex flex-wrap items-center gap-2">
            <USelect v-model="font.role" :items="KIT_FONT_ROLES.map(role => ({ label: role === 'headline' ? 'Headlines' : 'Body', value: role }))" class="w-32" aria-label="Used for" />
            <UInput v-model="font.family" placeholder="Inter" class="min-w-0 flex-1" aria-label="Family" />
            <UBadge v-if="font.file" :label="fileName(font.file)" icon="i-lucide-file-type" color="neutral" variant="subtle" size="sm" class="max-w-40 truncate" />
            <UButton
              v-if="isAdmin"
              :label="font.file ? 'Replace file' : 'Upload file'"
              :loading="font.uploading"
              size="xs"
              color="neutral"
              variant="subtle"
              @click="pickFont(index)"
            />
            <UButton v-if="font.file && isAdmin" icon="i-lucide-file-x" size="xs" color="neutral" variant="ghost" aria-label="Remove the file" @click="font.file = null" />
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove font" @click="kit.fonts.splice(index, 1)" />
          </div>
          <input ref="fontPicker" type="file" accept=".ttf,.otf,.woff,.woff2" class="hidden" @change="onFont">
          <UButton
            v-if="isAdmin && freeRole"
            :label="`Add a ${freeRole === 'headline' ? 'headline' : 'body'} font`"
            icon="i-lucide-plus"
            size="sm"
            color="neutral"
            variant="subtle"
            @click="kit.fonts.push({ role: freeRole!, family: '', file: null })"
          />
        </div>
      </UFormField>

      <UFormField label="Logos">
        <div class="space-y-2">
          <div v-for="(logo, index) in kit.logos" :key="logo.path" class="flex items-center gap-2">
            <span class="flex size-12 shrink-0 items-center justify-center rounded border border-default" :class="logo.use === 'dark' ? 'bg-neutral-900' : 'bg-white'">
              <img v-if="links[logo.path]" :src="links[logo.path]" alt="" class="max-h-10 max-w-10 object-contain">
            </span>
            <USelect v-model="logo.use" :items="LOGO_USES" class="w-32" aria-label="Use" />
            <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ fileName(logo.path) }}</span>
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove logo" @click="kit.logos.splice(index, 1)" />
          </div>
          <input ref="logoPicker" type="file" accept=".png,.jpg,.jpeg,.webp,.svg" multiple class="hidden" @change="onLogo">
          <UButton v-if="isAdmin" label="Add logos" icon="i-lucide-image-plus" size="sm" color="neutral" variant="subtle" @click="logoPicker?.click()" />
        </div>
      </UFormField>

      <UFormField label="Style notes" help="The look in words: photography, type, tone">
        <UTextarea v-model="kit.style_notes" autoresize :rows="2" class="w-full" />
      </UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Always" help="One per line, on top of every format's">
          <UTextarea v-model="kit.always" autoresize :rows="2" class="w-full" />
        </UFormField>
        <UFormField label="Never" help="One per line">
          <UTextarea v-model="kit.never" autoresize :rows="2" class="w-full" />
        </UFormField>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UIcon name="i-lucide-package" class="text-muted" />
        <span class="text-muted">Packshots go in the brand's Dropbox <code>_kit/packshots/</code> folder.</span>
        <UButton v-if="dropboxLink" :to="dropboxLink" target="_blank" label="Open in Dropbox" icon="i-lucide-external-link" size="xs" color="neutral" variant="subtle" />
        <span v-else class="text-xs text-dimmed">It's made with the first shoot's folders.</span>
      </div>
    </fieldset>

    <template #footer>
      <div class="flex items-center gap-3">
        <UButton label="Save design kit" :loading="saving" :disabled="!!problem" @click="save" />
        <span v-if="problem" class="text-xs text-error">{{ problem }}</span>
      </div>
    </template>
  </UCard>
</template>
