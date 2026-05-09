<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listMetricSamples, type MetricSample } from '../services/api'

const loading = ref(false)
const keyword = ref('')
const samples = ref<MetricSample[]>([])

const filteredSamples = computed(() => {
  const normalized = keyword.value.trim().toLowerCase()
  if (!normalized) return samples.value
  return samples.value.filter((sample) => `${sample.device_name} ${sample.metric_name}`.toLowerCase().includes(normalized))
})

async function loadData(): Promise<void> {
  loading.value = true
  try {
    samples.value = await listMetricSamples({ limit: 200 })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载采集数据失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <el-card class="page-card" shadow="never">
    <div class="page-toolbar">
      <h2 class="page-title">最新数据</h2>
      <div class="toolbar-actions toolbar-actions--wide">
        <el-input v-model="keyword" placeholder="搜索设备或指标" clearable />
        <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="filteredSamples" empty-text="暂无采集数据">
      <el-table-column prop="device_name" label="设备" min-width="180" show-overflow-tooltip />
      <el-table-column prop="metric_name" label="指标" min-width="180" show-overflow-tooltip />
      <el-table-column label="最新值" min-width="160">
        <template #default="{ row }">{{ row.value_text }} {{ row.unit }}</template>
      </el-table-column>
      <el-table-column prop="created_at" label="采集时间" width="240" />
    </el-table>
  </el-card>
</template>
