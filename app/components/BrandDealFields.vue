<script setup lang="ts">
// Trybe deal terms for a brand: how it pays (any mix of flat fee, retainer, commission and ad
// spend, each with its amount) and its Trybe numbers.
export interface BrandDeal {
  pay_types: string[]
  flat_fee: number | undefined
  retainer_fee: number | undefined
  commission_pct: number | undefined
  ad_spend_pct: number | undefined
  currency: string
  trybe_score: number | undefined
  trybe_url: string
}

const deal = defineModel<BrandDeal>({ required: true })

const chosen = computed(() => PAY_TYPES.filter(type => deal.value.pay_types.includes(type.value)))

function toggle(type: string, on: boolean | 'indeterminate') {
  const rest = deal.value.pay_types.filter(value => value !== type)
  deal.value.pay_types = on === true ? [...rest, type] : rest
}
</script>

<template>
  <div class="space-y-4">
    <UFormField label="Income" help="Tick every way the brand pays. Nothing ticked means not agreed yet.">
      <div class="grid grid-cols-2 gap-2 pt-1">
        <UCheckbox
          v-for="type in PAY_TYPES"
          :key="type.value"
          :model-value="deal.pay_types.includes(type.value)"
          :label="type.label"
          @update:model-value="toggle(type.value, $event)"
        />
      </div>
    </UFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField v-for="type in chosen" :key="type.value" :label="type.label" :help="type.help">
        <UInput
          v-model.number="deal[type.field]"
          type="number"
          min="0"
          :max="type.unit === 'pct' ? 100 : undefined"
          :step="type.unit === 'pct' ? 0.5 : 0.01"
          class="w-full"
        >
          <template v-if="type.unit === 'money'" #leading>
            <span class="text-xs text-muted">{{ currencySymbol(deal.currency) }}</span>
          </template>
          <template v-else #trailing>
            <span class="text-xs text-muted">%</span>
          </template>
        </UInput>
      </UFormField>
      <UFormField label="Currency">
        <USelect v-model="deal.currency" :items="CURRENCIES" class="w-full" />
      </UFormField>
      <UFormField label="Trybe score">
        <UInput v-model.number="deal.trybe_score" type="number" min="0" step="0.1" class="w-full" />
      </UFormField>
    </div>
    <UFormField label="Trybe URL" :error="isValidUrl(deal.trybe_url) ? undefined : 'Enter a valid link'">
      <UInput v-model="deal.trybe_url" type="url" icon="i-lucide-link" placeholder="https://" class="w-full" />
    </UFormField>
  </div>
</template>
