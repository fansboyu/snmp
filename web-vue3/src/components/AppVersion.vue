<script setup lang="ts">
import { version } from '../../package.json'

defineProps<{ compact?: boolean }>()
const versionLabel = `v${version}`
</script>

<template>
  <span class="app-version" :title="`前端版本 ${versionLabel}`" :aria-label="`前端版本 ${versionLabel}`">
    <span v-if="!compact" class="app-version__label">版本</span>
    <span class="app-version__number">{{ versionLabel }}</span>
  </span>
</template>

<style scoped>
.app-version {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.app-version__label {
  opacity: 0.8;
}
.app-version__number {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.3px;
}
</style>
