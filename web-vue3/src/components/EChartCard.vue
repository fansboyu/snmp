<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  options: echarts.EChartsOption
  height?: number
}>(), {
  description: '',
  height: 260
})

const chartRef = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

function renderChart(): void {
  if (!chartRef.value) return
  if (!chart) {
    chart = echarts.init(chartRef.value)
  }
  chart.setOption(props.options, true)
}

function resizeChart(): void {
  chart?.resize()
}

onMounted(() => {
  renderChart()
  window.addEventListener('resize', resizeChart)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeChart)
  chart?.dispose()
  chart = null
})

watch(() => props.options, renderChart, { deep: true })
</script>

<template>
  <el-card class="page-card chart-card" shadow="never">
    <div class="chart-card__header">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
    </div>
    <div ref="chartRef" class="chart-card__body" :style="{ height: `${height}px` }" />
  </el-card>
</template>
