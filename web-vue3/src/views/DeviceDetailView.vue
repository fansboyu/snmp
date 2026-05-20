<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import EChartCard from '../components/EChartCard.vue'
import MetricCard from '../components/MetricCard.vue'
import {
  getCollectionTrendChart,
  getCpuChart,
  getInterfaceStatusChart,
  getInterfaceTrafficChart,
  getMemoryChart,
  listDevices,
  listInterfaces,
  listMetricSamples,
  type ChartPoint,
  type Device,
  type DeviceInterface,
  type InterfaceStatusPoint,
  type MetricSample
} from '../services/api'

interface InterfaceTraffic {
  iface: DeviceInterface
  points: ChartPoint[]
}

const route = useRoute()
const router = useRouter()
const deviceId = computed(() => String(route.params.id || ''))
const loading = ref(false)
const device = ref<Device | null>(null)
const interfaces = ref<DeviceInterface[]>([])
const samples = ref<MetricSample[]>([])
const cpuSeries = ref<ChartPoint[]>([])
const memorySeries = ref<ChartPoint[]>([])
const statusSeries = ref<InterfaceStatusPoint[]>([])
const trendSeries = ref<ChartPoint[]>([])
const interfaceTraffic = ref<InterfaceTraffic[]>([])

const upCount = computed(() => statusCount('up'))
const downCount = computed(() => statusCount('down'))
const interfaceCount = computed(() => interfaces.value.length)

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

const memoryChartOptions = computed<EChartsOption>(() => ({
  color: ['#0f766e'],
  grid: { left: 42, right: 18, top: 26, bottom: 34 },
  tooltip: { trigger: 'axis', valueFormatter: (value) => `${Number(value || 0).toFixed(1)}%` },
  xAxis: { type: 'category', boundaryGap: false, data: memorySeries.value.map((point) => formatTime(point.time)) },
  yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
  series: [{
    name: 'Memory',
    type: 'line',
    smooth: true,
    symbolSize: 6,
    areaStyle: { color: 'rgba(15, 118, 110, 0.16)' },
    data: memorySeries.value.map((point) => point.value ?? 0)
  }]
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
  series: [{ name: '样本量', type: 'bar', barWidth: 18, data: trendSeries.value.map((point) => point.count ?? 0) }]
}))

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [deviceResult, interfaceResult, sampleResult, cpuResult, memoryResult, statusResult, trendResult] = await Promise.all([
      listDevices(),
      listInterfaces({ deviceId: deviceId.value }),
      listMetricSamples({ deviceId: deviceId.value, limit: 8 }),
      getCpuChart({ deviceId: deviceId.value, range: '1h' }),
      getMemoryChart({ deviceId: deviceId.value, range: '1h' }),
      getInterfaceStatusChart({ deviceId: deviceId.value }),
      getCollectionTrendChart({ deviceId: deviceId.value, range: '1h' })
    ])
    device.value = deviceResult.find((item) => String(item.id) === deviceId.value) ?? null
    interfaces.value = interfaceResult
    samples.value = sampleResult
    cpuSeries.value = cpuResult
    memorySeries.value = memoryResult
    statusSeries.value = statusResult
    trendSeries.value = trendResult
    interfaceTraffic.value = await Promise.all(
      interfaceResult.map(async (iface) => ({
        iface,
        points: await getInterfaceTrafficChart({ deviceId: deviceId.value, interfaceId: iface.id, range: '1h' })
      }))
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载设备监控失败')
  } finally {
    loading.value = false
  }
}

function trafficOptions(points: ChartPoint[]): EChartsOption {
  return {
    color: ['#16a34a', '#7c3aed'],
    legend: { top: 0, right: 8 },
    grid: { left: 54, right: 18, top: 36, bottom: 34 },
    tooltip: { trigger: 'axis', valueFormatter: (value) => formatBps(Number(value || 0)) },
    xAxis: { type: 'category', boundaryGap: false, data: points.map((point) => formatTime(point.time)) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatBps(value) } },
    series: [
      { name: '入流量', type: 'line', smooth: true, data: points.map((point) => point.in_bps ?? 0) },
      { name: '出流量', type: 'line', smooth: true, data: points.map((point) => point.out_bps ?? 0) }
    ]
  }
}

function statusCount(status: InterfaceStatusPoint['status']): number {
  return statusSeries.value.find((point) => point.status === status)?.count ?? 0
}

function interfaceLabel(iface: DeviceInterface): string {
  return iface.if_name || iface.if_descr || `ifIndex ${iface.if_index}`
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
      <div>
        <h2 class="page-title">{{ device?.name || '设备监控' }}</h2>
        <p class="page-subtitle">{{ device?.host }}{{ device?.group_name ? ` · ${device.group_name}` : '' }}</p>
      </div>
      <div class="toolbar-actions">
        <el-button @click="router.push('/devices')">返回设备管理</el-button>
        <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :span="6">
        <MetricCard title="设备状态" :value="device?.enabled ? '启用' : '停用'" description="当前采集开关" type="success" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="接口数量" :value="interfaceCount" description="已发现接口" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="UP 接口" :value="upCount" description="operStatus = up" type="success" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="DOWN 接口" :value="downCount" description="operStatus = down" type="danger" />
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="8">
        <EChartCard title="CPU 使用率" description="当前设备最近 1 小时 CPU 趋势" :options="cpuChartOptions" />
      </el-col>
      <el-col :span="8">
        <EChartCard title="内存使用率" description="当前设备最近 1 小时内存趋势" :options="memoryChartOptions" />
      </el-col>
      <el-col :span="8">
        <EChartCard title="接口状态分布" description="当前设备接口 UP / DOWN / UNKNOWN" :options="statusChartOptions" />
      </el-col>
      <el-col :span="8">
        <EChartCard title="采集样本趋势" description="当前设备每 5 分钟样本写入量" :options="trendChartOptions" />
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>接口清单</template>
      <el-table :data="interfaces" row-key="id" empty-text="暂无接口数据">
        <el-table-column prop="if_index" label="ifIndex" width="100" />
        <el-table-column label="接口" min-width="180">
          <template #default="{ row }">{{ interfaceLabel(row) }}</template>
        </el-table-column>
        <el-table-column prop="if_descr" label="描述" min-width="220" show-overflow-tooltip />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.oper_status === '1' || row.oper_status === 'up' ? 'success' : 'danger'">
              {{ row.oper_status === '1' || row.oper_status === 'up' ? 'UP' : row.oper_status === '2' || row.oper_status === 'down' ? 'DOWN' : 'UNKNOWN' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="last_seen_at" label="最近发现" width="220" />
      </el-table>
    </el-card>

    <div class="section-title">接口流量图表</div>
    <el-empty v-if="interfaceTraffic.length === 0" description="暂无接口流量数据" />
    <el-row v-else :gutter="16">
      <el-col v-for="item in interfaceTraffic" :key="item.iface.id" :span="12" class="interface-chart-col">
        <EChartCard
          :title="interfaceLabel(item.iface)"
          :description="`ifIndex ${item.iface.if_index} · 入/出方向流量`"
          :options="trafficOptions(item.points)"
          :height="240"
        />
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>最新采集数据</template>
      <el-table :data="samples" empty-text="暂无采集数据">
        <el-table-column prop="metric_name" label="指标" min-width="180" show-overflow-tooltip />
        <el-table-column label="值" width="160">
          <template #default="{ row }">{{ row.value_text }} {{ row.unit }}</template>
        </el-table-column>
        <el-table-column prop="created_at" label="采集时间" width="240" />
      </el-table>
    </el-card>
  </div>
</template>
