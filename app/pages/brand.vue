<script setup lang="ts">
// A brand account's Brand page: its one brand (profile, products, library rule), opened on the brand
// page itself. Creator accounts have Brands instead.
const db = useDb()
const { data } = await db.from('brands').select('id').order('created_at').limit(1).maybeSingle()
await navigateTo(data ? `/brands/${data.id}` : '/library', { replace: true })
</script>

<template>
  <div />
</template>
