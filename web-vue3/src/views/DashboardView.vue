<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import { ElMessage } from 'element-plus'
import EChartCard from '../components/EChartCard.vue'
import MetricCard from '../components/MetricCard.vue'
import {
  getCollectionTrendChart,
  getCpuChart,
  getInterfaceStatusChart,
  getInterfaceTrafficChart,
  listDevices,
  listMetricDefinitions,
  listMetricSamples,
  type ChartPoint,
  type Device,
  type InterfaceStatusPoint,
  type MetricDefinition,
  type MetricSample
} from '../services/api'

const loading = ref(false)
const devices = ref<Device[]>([])
const definitions = ref<MetricDefinition[]>([])
const samples = ref<MetricSample[]>([])
const cpuSeries = ref<ChartPoint[]>([])
const trafficSeries = ref<ChartPoint[]>([])
const statusSeries = ref<InterfaceStatusPoint[]>([])
const trendSeries = ref<ChartPoint[]>([])

const enabledDevices = computed(() => devices.value.filter((device) => device.enabled).length)
const interfaceMetricCount = computed(() => definitions.value.filter((definition) => definition.metric_kind === 'interface').length)

const cpuChartOptions = computed<EChartsOption>(() => ({
  color: ['#2563eb'],
  grid: { left: 42, right: 18, top: 26, bottom: 34 },
  tooltip: { trigger: 'axis', valueFormatter: (value) => `${Number(value || 0).toFixed(1)}%` },
  xAxis: { type: 'category', boundaryGap: false, data: cpuSeries.value.map((point) => formatTime(point.time)) },
  yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
  series: [{
    name: 'CPU',
    type: 'line',
    smooth: true,
    symbolSize: 6,
    areaStyle: { color: 'rgba(37, 99, 235, 0.16)' },
    data: cpuSeries.value.map((point) => point.value ?? 0)
  }]
}))

const trafficChartOptions = computed<EChartsOption>(() => ({
  color: ['#16a34a', '#7c3aed'],
  legend: { top: 0, right: 8 },
  grid: { left: 54, right: 18, top: 36, bottom: 34 },
  tooltip: { trigger: 'axis', valueFormatter: (value) => formatBps(Number(value || 0)) },
  xAxis: { type: 'category', boundaryGap: false, data: trafficSeries.value.map((point) => formatTime(point.time)) },
  yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatBps(value) } },
  series: [
    { name: '入流量', type: 'line', smooth: true, data: trafficSeries.value.map((point) => point.in_bps ?? 0) },
    { name: '出流量', type: 'line', smooth: true, data: trafficSeries.value.map((point) => point.out_bps ?? 0) }
  ]
}))

const statusChartOptions = computed<EChartsOption>(() => ({
  color: ['#16a34a', '#dc2626', '#94a3b8'],
  tooltip: { trigger: 'item' },
  legend: { bottom: 0 },
  series: [{
    name: '接口状态',
    type: 'pie',
    radius: ['48%', '72%'],
    center: ['50%', '45%'],
    label: { formatter: '{b}: {c}' },
    data: [
      { name: 'UP', value: statusCount('up') },
      { name: 'DOWN', value: statusCount('down') },
      { name: 'UNKNOWN', value: statusCount('unknown') }
    ]
  }]
}))

const trendChartOptions = computed<EChartsOption>(() => ({
  color: ['#f59e0b'],
  grid: { left: 44, right: 18, top: 24, bottom: 34 },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: trendSeries.value.map((point) => formatTime(point.time)) },
  yAxis: { type: 'value' },
  series: [{
    name: '样本量',
    type: 'bar',
    barWidth: 18,
    data: trendSeries.value.map((point) => point.count ?? 0)
  }]
}))

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [
      deviceResult,
      definitionResult,
      sampleResult,
      cpuResult,
      trafficResult,
      statusResult,
      trendResult
    ] = await Promise.all([
      listDevices(),
      listMetricDefinitions(),
      listMetricSamples({ limit: 8 }),
      getCpuChart({ range: '1h' }),
      getInterfaceTrafficChart({ range: '1h' }),
      getInterfaceStatusChart(),
      getCollectionTrendChart({ range: '1h' })
    ])
    devices.value = deviceResult
    definitions.value = definitionResult
    samples.value = sampleResult
    cpuSeries.value = cpuResult
    trafficSeries.value = trafficResult
    statusSeries.value = statusResult
    trendSeries.value = trendResult
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function statusCount(status: InterfaceStatusPoint['status']): number {
  return statusSeries.value.find((point) => point.status === status)?.count ?? 0
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatBps(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} Kbps`
  return `${value.toFixed(0)} bps`
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
        <MetricCard title="在线设备" :value="enabledDevices" :description="`启用 ${enabledDevices} 台`" type="success" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="设备总数" :value="devices.length" :description="`已纳管 ${devices.length} 台`" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="指标定义" :value="definitions.length" :description="`接口指标 ${interfaceMetricCount} 个`" type="warning" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="样本数量" :value="samples.length" description="最近采集样本预览" type="danger" />
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="12">
        <EChartCard title="CPU 使用率" description="最近 1 小时平均 CPU 趋势" :options="cpuChartOptions" />
      </el-col>
      <el-col :span="12">
        <EChartCard title="接口入/出流量" description="基于 ifInOctets / ifOutOctets 自动换算 bps" :options="trafficChartOptions" />
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="12">
        <EChartCard title="接口状态分布" description="统计 UP、DOWN 和 UNKNOWN 接口数量" :options="statusChartOptions" />
      </el-col>
      <el-col :span="12">
        <EChartCard title="采集样本趋势" description="每 5 分钟样本写入量" :options="trendChartOptions" />
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
