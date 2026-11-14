<script setup lang="ts">
// The star on a brand: marks the particularly good ones. Emits toggle; the parent saves.
defineProps<{ starred: boolean, name: string, size?: 'xs' | 'sm' | 'md' }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <UTooltip :text="starred ? 'Starred: a particularly good brand' : 'Star this brand'">
    <UButton
      icon="i-lucide-star"
      :color="starred ? 'warning' : 'neutral'"
      variant="ghost"
      :size="size ?? 'xs'"
      :aria-label="starred ? `Unstar ${name}` : `Star ${name}`"
      :aria-pressed="starred"
      :ui="{ leadingIcon: starred ? 'fill-current' : 'opacity-50' }"
      @click.prevent.stop="$emit('toggle')"
    />
  </UTooltip>
</template>
