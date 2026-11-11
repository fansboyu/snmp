<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  title: string
  value: string | number
  description?: string
  type?: 'primary' | 'success' | 'warning' | 'danger'
  icon?: Component
}>()
</script>

<template>
  <el-card class="metric-card" :class="{ 'metric-card--with-icon': icon }" shadow="never">
    <div class="metric-card__heading">
      <div class="metric-card__title">{{ title }}</div>
      <span v-if="icon" class="metric-card__icon" :class="`metric-card__icon--${type || 'primary'}`" aria-hidden="true">
        <el-icon><component :is="icon" /></el-icon>
      </span>
    </div>
    <div class="metric-card__value" :class="`metric-card__value--${type || 'primary'}`">{{ value }}</div>
    <div class="metric-card__desc">{{ description }}</div>
  </el-card>
</template>

<style scoped>
.metric-card__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 30px;
}

.metric-card__icon {
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  font-size: 18px;
}

.metric-card__icon--primary { color: #3286d8; background: #eaf4ff; }
.metric-card__icon--success { color: #19a66a; background: #e9f8f0; }
.metric-card__icon--warning { color: #d99318; background: #fff5df; }
.metric-card__icon--danger { color: #e25353; background: #fff0ef; }
</style>
