<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import EChartCard from '../components/EChartCard.vue'
import MetricCard from '../components/MetricCard.vue'
import FollowedPortCard from '../components/FollowedPortCard.vue'
import { StarFilled, Plus } from '@element-plus/icons-vue'
import { usePortFavorites } from '../services/port-favorites'
import { formatRate, localTime, dataStatusNames } from '../services/traffic-format'
import {
  getCollectionTrendChart,
  getCpuChart,
  getInterfaceStatusChart,
  getMemoryChart,
  getPortTraffic,
  listDevices,
  listInterfaces,
  listMetricSamples,
  type ChartPoint,
  type Device,
  type DeviceInterface,
  type InterfaceStatusPoint,
  type MetricSample,
  type PortTrafficResult
} from '../services/api'

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
const interfaceKeyword = ref('')
const interfacePage = ref(1)
const favorites = usePortFavorites()
const followedPorts = computed(() => interfaces.value.filter(port => favorites.ids.value.includes(String(port.id))))
const followedTraffic = ref<Record<string, PortTrafficResult>>({})
const followedErrors = ref<Record<string, string>>({})
const followedLoading = ref<string[]>([])
const pickerVisible = ref(false)
const pickerKeyword = ref('')
const selectedPorts = ref<string[]>([])
const selectablePorts = computed(() => interfaces.value.filter(port => `${interfaceLabel(port)} ${port.user_note || ''} ${port.if_alias || ''}`.toLowerCase().includes(pickerKeyword.value.toLowerCase())))
const diagnosticPanels = ref<string[]>([])
const diagnosticLoading = ref(false)
let dataSequence = 0
let trafficSequence = 0
let diagnosticSequence = 0
let trafficController: AbortController | undefined
let disposed = false
const followSignature = () => `${deviceId.value}:${followedPorts.value.map(port => String(port.id)).join(',')}`
const matchingInterfaces = computed(() => interfaces.value.filter(i => `${i.if_name} ${i.if_descr} ${i.if_alias} ${i.user_note}`.toLowerCase().includes(interfaceKeyword.value.toLowerCase())))
const pagedInterfaces = computed(() => matchingInterfaces.value.slice((interfacePage.value-1)*15,interfacePage.value*15))

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
    data: cpuSeries.value.map((point) => point.value ?? null)
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
    data: memorySeries.value.map((point) => point.value ?? null)
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
  const sequence = ++dataSequence
  const id = deviceId.value
  loading.value = true
  try {
    const [deviceResult, interfaceResult, cpuResult, memoryResult, statusResult] = await Promise.all([
      listDevices(),
      listInterfaces({ deviceId: id }),
      getCpuChart({ deviceId: id, range: '1h' }),
      getMemoryChart({ deviceId: id, range: '1h' }),
      getInterfaceStatusChart({ deviceId: id })
    ])
    if (disposed || sequence !== dataSequence) return
    const oldSignature = followSignature()
    device.value = deviceResult.find((item) => String(item.id) === id) ?? null
    interfaces.value = interfaceResult
    cpuSeries.value = cpuResult
    memorySeries.value = memoryResult
    statusSeries.value = statusResult
    // The watcher handles membership changes; refresh unchanged memberships here.
    if (oldSignature === followSignature()) void loadFollowedTraffic()
    if (diagnosticPanels.value.includes('collection')) void loadDiagnostics()
  } catch (error) {
    if (!disposed && sequence === dataSequence) ElMessage.error(error instanceof Error ? error.message : '加载设备监控失败')
  } finally {
    if (sequence === dataSequence) loading.value = false
  }
}

async function loadFollowedTraffic(): Promise<void> {
  const sequence = ++trafficSequence
  trafficController?.abort()
  trafficController = new AbortController()
  const signal = trafficController.signal
  const id = deviceId.value
  const ids = followedPorts.value.map(port => String(port.id))
  followedTraffic.value = Object.fromEntries(Object.entries(followedTraffic.value).filter(([key]) => ids.includes(key)))
  followedErrors.value = {}
  followedLoading.value = [...ids]
  let next = 0
  const worker = async () => {
    while (next < ids.length && !signal.aborted) {
      const portId = ids[next++]!
      try {
        const result = await getPortTraffic(portId, { deviceId: id, range: '1h' }, signal)
        if (!disposed && sequence === trafficSequence) followedTraffic.value[portId] = result
      } catch (error) {
        if (!signal.aborted && !disposed && sequence === trafficSequence) followedErrors.value[portId] = error instanceof Error ? error.message : '加载失败'
      } finally {
        if (sequence === trafficSequence) followedLoading.value = followedLoading.value.filter(value => value !== portId)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker))
}

async function loadDiagnostics(): Promise<void> {
  if (!diagnosticPanels.value.includes('collection')) return
  const sequence = ++diagnosticSequence
  const id = deviceId.value
  diagnosticLoading.value = true
  try {
    const [trend, latest] = await Promise.all([
      getCollectionTrendChart({ deviceId: id, range: '1h' }),
      listMetricSamples({ deviceId: id, limit: 8 })
    ])
    if (disposed || sequence !== diagnosticSequence || id !== deviceId.value) return
    trendSeries.value = trend
    samples.value = latest
  } catch (error) {
    if (!disposed && sequence === diagnosticSequence) ElMessage.error(error instanceof Error ? error.message : '加载采集诊断失败')
  } finally { if (sequence === diagnosticSequence) diagnosticLoading.value = false }
}

function openPicker(): void {
  selectedPorts.value = followedPorts.value.map(port => String(port.id))
  pickerKeyword.value = ''
  pickerVisible.value = true
}
function saveSelection(): void {
  try {
    favorites.replaceForDevice(interfaces.value.map(port => String(port.id)), selectedPorts.value)
    pickerVisible.value = false
    ElMessage.success('关注端口已更新')
  } catch { ElMessage.error('无法保存关注端口，请检查浏览器存储设置') }
}
function togglePort(id: string): void {
  try { favorites.toggle(id) } catch { ElMessage.error('无法保存关注端口，请检查浏览器存储设置') }
}
function openPort(id: string): void { void router.push(`/devices/${deviceId.value}/interfaces/${id}`) }

function statusCount(status: InterfaceStatusPoint['status']): number {
  return statusSeries.value.find((point) => point.status === status)?.count ?? 0
}

function interfaceLabel(iface: DeviceInterface): string {
  return iface.if_name || iface.if_descr || `ifIndex ${iface.if_index}`
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

watch(followSignature, () => { void loadFollowedTraffic() })
watch(deviceId, () => {
  interfaces.value = []
  device.value = null
  followedTraffic.value = {}
  diagnosticSequence++
  trendSeries.value = []
  samples.value = []
  interfacePage.value = 1
  pickerVisible.value = false
  void loadData()
}, { immediate: true })
watch(diagnosticPanels, () => { void loadDiagnostics() })
const refreshTimer = window.setInterval(() => {
  if (!document.hidden && !loading.value && !pickerVisible.value) void loadData()
}, 60000)
onBeforeUnmount(() => {
  disposed = true
  dataSequence++
  trafficSequence++
  diagnosticSequence++
  trafficController?.abort()
  window.clearInterval(refreshTimer)
})
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
      <el-col :xs="12" :sm="6">
        <MetricCard title="设备状态" :value="device?.enabled ? '启用' : '停用'" description="当前采集开关" type="success" />
      </el-col>
      <el-col :xs="12" :sm="6">
        <MetricCard title="接口数量" :value="interfaceCount" description="已发现接口" />
      </el-col>
      <el-col :xs="12" :sm="6">
        <MetricCard title="UP 接口" :value="upCount" description="operStatus = up" type="success" />
      </el-col>
      <el-col :xs="12" :sm="6">
        <MetricCard title="DOWN 接口" :value="downCount" description="operStatus = down" type="danger" />
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :xs="24" :sm="8">
        <EChartCard title="CPU 使用率" description="当前设备最近 1 小时 CPU 趋势" :options="cpuChartOptions" />
      </el-col>
      <el-col :xs="24" :sm="8">
        <EChartCard title="内存使用率" description="当前设备最近 1 小时内存趋势" :options="memoryChartOptions" />
      </el-col>
      <el-col :xs="24" :sm="8">
        <EChartCard title="接口状态分布" description="当前设备接口 UP / DOWN / UNKNOWN" :options="statusChartOptions" />
      </el-col>
    </el-row>

    <section class="device-followed-section dashboard-row" aria-label="当前设备关注端口">
      <div class="device-followed-toolbar">
        <h3><el-icon><StarFilled /></el-icon>关注端口 <el-tag size="small">{{ followedPorts.length }}</el-tag></h3>
        <div class="toolbar-actions"><span class="device-followed-hint">仅当前设备 · 每 60 秒刷新</span><el-button :icon="Plus" @click="openPicker">选择关注端口</el-button></div>
      </div>
      <div v-if="followedPorts.length" class="device-followed-grid">
        <FollowedPortCard v-for="port in followedPorts" :key="port.id" :port="port" :traffic="followedTraffic[String(port.id)]" :loading="followedLoading.includes(String(port.id))" :error="followedErrors[String(port.id)]" @open="openPort(String(port.id))" @unfollow="togglePort(String(port.id))" />
      </div>
      <el-card v-else class="device-followed-empty" shadow="never">
        <el-empty :image-size="70" description="还没有关注的端口，选择常用上联口或业务口，在这里快速查看流量"><el-button type="primary" @click="openPicker">选择关注端口</el-button></el-empty>
      </el-card>
    </section>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header><div class="page-toolbar"><span>端口流量 · 点击端口进入详情</span><el-input v-model="interfaceKeyword" style="width:280px" placeholder="搜索端口名称或业务备注" clearable @input="interfacePage=1" /></div></template>
      <el-table :data="pagedInterfaces" row-key="id" empty-text="暂无匹配端口">
        <el-table-column prop="if_index" label="ifIndex" width="100" />
        <el-table-column label="接口" min-width="180">
          <template #default="{ row }"><el-button type="primary" link @click="openPort(String(row.id))">{{ interfaceLabel(row) }}</el-button></template>
        </el-table-column>
        <el-table-column label="业务备注" min-width="160" show-overflow-tooltip><template #default="{row}">{{row.user_note||row.if_alias||'—'}}</template></el-table-column>
        <el-table-column label="入速率" min-width="130"><template #default="{row}">{{formatRate(row.traffic_summary?.in_bps)}}</template></el-table-column>
        <el-table-column label="出速率" min-width="130"><template #default="{row}">{{formatRate(row.traffic_summary?.out_bps)}}</template></el-table-column>
        <el-table-column label="数据状态" min-width="130"><template #default="{row}">{{dataStatusNames[row.traffic_summary?.data_status||'no_data']}}</template></el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.oper_status === '1' || row.oper_status === 'up' ? 'success' : 'danger'">
              {{ row.oper_status === '1' || row.oper_status === 'up' ? 'UP' : row.oper_status === '2' || row.oper_status === 'down' ? 'DOWN' : 'UNKNOWN' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后流量采样" width="190"><template #default="{row}">{{localTime(row.traffic_summary?.sampled_at)}}</template></el-table-column>
        <el-table-column label="关注" width="110" fixed="right"><template #default="{ row }"><el-button link :type="favorites.ids.value.includes(String(row.id)) ? 'primary' : 'info'" :aria-label="`${favorites.ids.value.includes(String(row.id)) ? '取消关注' : '关注'} ${interfaceLabel(row)}`" @click="togglePort(String(row.id))">{{ favorites.ids.value.includes(String(row.id)) ? '★ 已关注' : '☆ 关注' }}</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="interfacePage" :page-size="15" :total="matchingInterfaces.length" layout="total, prev, pager, next" style="margin-top:16px" />
    </el-card>

    <el-collapse v-model="diagnosticPanels" class="device-diagnostics dashboard-row">
      <el-collapse-item title="采集诊断 / 样本趋势与最新采集数据" name="collection">
       <div v-if="diagnosticPanels.includes('collection')" v-loading="diagnosticLoading">
        <EChartCard title="采集样本趋势" description="当前设备每 5 分钟样本写入量" :options="trendChartOptions" />
        <el-card class="page-card" shadow="never">
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
      </el-collapse-item>
    </el-collapse>

    <el-dialog v-model="pickerVisible" title="选择关注端口" class="device-followed-dialog" width="min(640px, calc(100vw - 32px))">
      <el-input v-model="pickerKeyword" placeholder="搜索端口名称或业务备注" clearable />
      <p class="device-followed-hint">已选 {{ selectedPorts.length }} 个 · 关注状态与端口详情同步</p>
      <el-checkbox-group v-model="selectedPorts" class="device-port-picker">
        <el-checkbox v-for="port in selectablePorts" :key="port.id" :value="String(port.id)"><div><strong>{{ interfaceLabel(port) }}</strong><span>{{ port.user_note || port.if_alias || '暂无业务备注' }} · {{ formatRate(Number(port.speed_bps) || null) }}</span></div></el-checkbox>
      </el-checkbox-group>
      <el-empty v-if="!selectablePorts.length" :image-size="50" description="暂无匹配端口" />
      <template #footer><el-button @click="pickerVisible = false">取消</el-button><el-button type="primary" @click="saveSelection">保存关注</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.device-followed-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.device-followed-section{container-type:inline-size}
.device-followed-toolbar h3{margin:0;display:flex;align-items:center;gap:8px;font-size:16px;color:#172033}
.device-followed-toolbar h3 .el-icon{color:#2563eb}
.device-followed-hint{color:#64748b;font-size:13px}
.device-followed-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.device-followed-empty{border-radius:14px;border-style:dashed}
.device-diagnostics{border:0;background:transparent}
.device-port-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:420px;overflow:auto}
.device-port-picker .el-checkbox{margin:0;height:auto;min-height:68px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;white-space:normal}
.device-port-picker span{display:block;color:#64748b;font-size:12px;margin-top:3px;overflow-wrap:anywhere}
.device-port-picker :deep(.el-checkbox__label){min-width:0;white-space:normal}
:deep(.device-followed-dialog){max-width:calc(100vw - 32px)}
@media(max-width:1100px){.device-followed-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.device-followed-grid,.device-port-picker{grid-template-columns:minmax(0,1fr)}}
@container(max-width:850px){.device-followed-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container(max-width:550px){.device-followed-grid{grid-template-columns:minmax(0,1fr)}}
</style>
