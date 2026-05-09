<script setup lang="ts">
defineProps<{
  title: string
  value: string | number
  description?: string
  type?: 'primary' | 'success' | 'warning' | 'danger'
}>()
</script>

<template>
  <el-card class="metric-card" shadow="never">
    <div class="metric-card__title">{{ title }}</div>
    <div class="metric-card__value" :class="`metric-card__value--${type || 'primary'}`">{{ value }}</div>
    <div class="metric-card__desc">{{ description }}</div>
  </el-card>
</template>
