<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import MetricCard from '../components/MetricCard.vue'
import { getHealth, listDevices, listMetricDefinitions, listMetricSamples, type Device, type HealthStatus, type MetricDefinition, type MetricSample } from '../services/api'

const loading = ref(false)
const health = ref<HealthStatus | null>(null)
const devices = ref<Device[]>([])
const definitions = ref<MetricDefinition[]>([])
const samples = ref<MetricSample[]>([])

const enabledDevices = computed(() => devices.value.filter((device) => device.enabled).length)

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [healthResult, deviceResult, definitionResult, sampleResult] = await Promise.all([
      getHealth(),
      listDevices(),
      listMetricDefinitions(),
      listMetricSamples({ limit: 8 })
    ])
    health.value = healthResult
    devices.value = deviceResult
    definitions.value = definitionResult
    samples.value = sampleResult
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <h2 class="page-title">SNMP 监控概览</h2>
      <el-button type="primary" @click="loadData">刷新</el-button>
    </div>

    <el-row :gutter="16">
      <el-col :span="6">
        <MetricCard title="API 状态" :value="health?.status || '-'" description="Fastify API Gateway" type="success" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="设备数量" :value="devices.length" :description="`启用 ${enabledDevices} 台`" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="指标定义" :value="definitions.length" description="当前配置 OID 数量" type="warning" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="样本数量" :value="samples.length" description="最近采集样本预览" type="danger" />
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>最新采集数据</template>
      <el-table :data="samples" empty-text="暂无采集数据">
        <el-table-column prop="device_name" label="设备" min-width="180" show-overflow-tooltip />
        <el-table-column prop="metric_name" label="指标" min-width="180" show-overflow-tooltip />
        <el-table-column label="值" width="160">
          <template #default="{ row }">{{ row.value_text }} {{ row.unit }}</template>
        </el-table-column>
        <el-table-column prop="created_at" label="采集时间" width="240" />
      </el-table>
    </el-card>
  </div>
</template>
