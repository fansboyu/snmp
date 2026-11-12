<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Bell,
  ChatLineRound,
  CircleCheckFilled,
  CircleCloseFilled,
  Clock,
  Cpu,
  Document,
  Download,
  Filter,
  List,
  Location,
  Monitor,
  Operation,
  Refresh,
  Search,
  Timer,
  WarningFilled
} from '@element-plus/icons-vue'
import type { Device } from '../services/api'
import {
  getSyslogEvents,
  getSyslogStatus,
  listDevices,
  type SyslogEvent,
  type SyslogEventPage,
  type SyslogEventQuery,
  type SyslogStatus
} from '../services/api'

const router = useRouter()
const loading = ref(false)
const statusLoading = ref(false)
const autoRefresh = ref(true)
const query = ref('')
const deviceId = ref('')
const severity = ref('')
const range = ref('1h')
const customRange = ref<[string, string] | null>(null)
const page = ref(1)
const pageSize = 50
const devices = ref<Device[]>([])
const status = ref<SyslogStatus | null>(null)
const result = ref<SyslogEventPage | null>(null)
const selected = ref<SyslogEvent | null>(null)
let refreshTimer: ReturnType<typeof setInterval> | undefined

const pageCount = computed(() => Math.max(1, Math.ceil((result.value?.total || 0) / pageSize)))
const lastReceived = computed(() => status.value?.last_received_at ? formatDate(status.value.last_received_at) : '尚未收到日志')

function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

const severityLabels: Record<number, string> = {
  0: '紧急', 1: '警报', 2: '严重', 3: '错误', 4: '警告', 5: '通知', 6: '信息', 7: '调试'
}
const facilityNames = ['内核', '用户', '邮件', '守护进程', '认证', 'syslog', '打印', '新闻', 'UUCP', '时钟', '认证私有', 'FTP', 'NTP', '审计', '告警', '时钟', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7']

function severityName(value: number | null): string {
  return value === null ? '未解析' : severityLabels[value] || `级别 ${value}`
}

function severityType(value: number | null): 'danger' | 'warning' | 'info' | 'success' {
  if (value === null) return 'info'
  if (value <= 3) return 'danger'
  if (value === 4) return 'warning'
  if (value <= 6) return 'success'
  return 'info'
}

function facilityName(value: number | null): string {
  return value === null ? '未知' : `${facilityNames[value] || '未知'} (${value})`
}

function queryParams(): SyslogEventQuery | null {
  const params: SyslogEventQuery = {
    q: query.value.trim() || undefined,
    deviceId: deviceId.value || undefined,
    severity: severity.value || undefined,
    page: page.value,
    pageSize
  }
  if (range.value === 'custom') {
    if (!customRange.value?.[0] || !customRange.value?.[1]) {
      ElMessage.warning('请选择完整的开始和结束时间')
      return null
    }
    params.start = new Date(customRange.value[0]).toISOString()
    params.end = new Date(customRange.value[1]).toISOString()
  } else {
    params.range = range.value
  }
  return params
}

async function loadStatus(): Promise<void> {
  statusLoading.value = true
  try {
    status.value = await getSyslogStatus()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取 Syslog 接收状态失败')
  } finally {
    statusLoading.value = false
  }
}

async function loadEvents(): Promise<void> {
  const params = queryParams()
  if (!params) return
  loading.value = true
  try {
    const response = await getSyslogEvents(params)
    result.value = response
    if (selected.value) {
      selected.value = response.items.find((item) => item.id === selected.value?.id) || response.items[0] || null
    } else {
      selected.value = response.items[0] || null
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '搜索 Syslog 日志失败')
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  await Promise.all([loadStatus(), loadEvents()])
}

function search(): void {
  page.value = 1
  void loadEvents()
}

function setQuickSeverity(value: string): void {
  severity.value = severity.value === value ? '' : value
  page.value = 1
  void loadEvents()
}

function changePage(value: number): void {
  page.value = value
  void loadEvents()
}

function exportCurrentPage(): void {
  const items = result.value?.items || []
  if (!items.length) {
    ElMessage.info('当前没有可导出的日志')
    return
  }
  const fields = ['接收时间', '设备', '来源 IP', 'Facility', 'Severity', '程序', '进程 ID', '消息']
  const rows = items.map((event) => [
    event.received_at,
    event.device_name || event.hostname || '未匹配设备',
    event.source_ip,
    facilityName(event.facility),
    severityName(event.severity),
    event.app_name || '',
    event.procid || '',
    event.message
  ])
  const csv = [fields, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `syslog-${new Date().toISOString().replace(/:/g, '-')}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function openDevice(event: SyslogEvent): void {
  if (event.device_id) void router.push(`/devices/${event.device_id}`)
}

onMounted(async () => {
  const [deviceResult] = await Promise.all([listDevices().catch(() => [])])
  devices.value = deviceResult
  await refresh()
  refreshTimer = setInterval(() => {
    if (autoRefresh.value && document.visibilityState === 'visible' && !loading.value) void refresh()
  }, 15000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="syslog-view" v-loading="loading">
    <div class="page-toolbar">
      <div>
        <h2 class="page-title"><el-icon class="page-title-icon"><ChatLineRound /></el-icon>系统日志</h2>
        <p class="page-subtitle">集中检索网络设备 Syslog，快速定位接口、链路和系统事件</p>
      </div>
      <div class="syslog-toolbar-actions">
        <el-tag :type="status?.online ? 'success' : 'danger'" effect="light">
          <el-icon class="status-icon"><CircleCheckFilled v-if="status?.online" /><CircleCloseFilled v-else /></el-icon>
          {{ status?.online ? `接收正常 · UDP ${status.host_port || 514}` : '收集器未连接' }}
        </el-tag>
        <el-switch v-model="autoRefresh" active-text="15 秒刷新" />
        <el-button :icon="Refresh" :loading="statusLoading" @click="refresh">刷新</el-button>
        <el-button :icon="Download" @click="exportCurrentPage">导出当前页</el-button>
      </div>
    </div>

    <el-row :gutter="12" class="syslog-stats">
      <el-col :xs="12" :sm="6"><el-card shadow="never"><span class="stat-label"><el-icon><Clock /></el-icon>最近 1 小时</span><strong>{{ status?.last_hour_count ?? 0 }}</strong><small>条日志</small></el-card></el-col>
      <el-col :xs="12" :sm="6"><el-card shadow="never"><span class="stat-label"><el-icon><WarningFilled /></el-icon>严重</span><strong class="text-danger">{{ status?.critical_count ?? 0 }}</strong><small>条</small></el-card></el-col>
      <el-col :xs="12" :sm="6"><el-card shadow="never"><span class="stat-label"><el-icon><Bell /></el-icon>错误</span><strong class="text-warning">{{ status?.error_count ?? 0 }}</strong><small>条</small></el-card></el-col>
      <el-col :xs="12" :sm="6"><el-card shadow="never"><span class="stat-label"><el-icon><Timer /></el-icon>最近收到</span><strong class="last-received">{{ lastReceived }}</strong><small>接收时间</small></el-card></el-col>
    </el-row>

    <el-card class="search-panel dashboard-row" shadow="never">
      <div class="search-controls">
        <el-input
          v-model="query"
          class="search-query"
          clearable
          :prefix-icon="Search"
          placeholder="搜索消息、设备名称、IP 或进程…"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="deviceId" clearable filterable placeholder="全部设备" @change="search">
          <el-option v-for="device in devices" :key="device.id" :label="`${device.name} · ${device.host}`" :value="String(device.id)" />
        </el-select>
        <el-select v-model="severity" clearable placeholder="全部级别" @change="search">
          <el-option label="严重（0–2）" value="critical" />
          <el-option label="错误（3）" value="error" />
          <el-option label="警告（4）" value="warning" />
          <el-option label="通知/信息（5–7）" value="info" />
          <el-option label="未解析" value="unclassified" />
        </el-select>
        <el-select v-model="range" class="range-select" @change="search">
          <el-option label="最近 1 小时" value="1h" />
          <el-option label="最近 6 小时" value="6h" />
          <el-option label="最近 24 小时" value="24h" />
          <el-option label="最近 7 天" value="7d" />
          <el-option label="自定义时间" value="custom" />
        </el-select>
        <el-date-picker
          v-if="range === 'custom'"
          v-model="customRange"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          value-format="YYYY-MM-DDTHH:mm:ss"
          @change="search"
        />
        <el-button type="primary" :icon="Search" @click="search">搜索日志</el-button>
      </div>
      <div class="quick-filters">
        <span class="muted-label"><el-icon><Filter /></el-icon>快捷筛选</span>
        <el-button size="small" :type="severity ? 'default' : 'primary'" plain @click="setQuickSeverity('')">全部</el-button>
        <el-button size="small" :type="severity === 'critical' ? 'danger' : 'default'" plain @click="setQuickSeverity('critical')"><el-icon><WarningFilled /></el-icon>严重</el-button>
        <el-button size="small" :type="severity === 'error' ? 'danger' : 'default'" plain @click="setQuickSeverity('error')"><el-icon><Bell /></el-icon>错误</el-button>
        <el-button size="small" :type="severity === 'warning' ? 'warning' : 'default'" plain @click="setQuickSeverity('warning')"><el-icon><WarningFilled /></el-icon>警告</el-button>
        <span class="collector-meta">已接收 {{ status?.received_count || 0 }} · 已保存 {{ status?.stored_count || 0 }} · 丢弃 {{ status?.dropped_count || 0 }}</span>
      </div>
      <el-alert v-if="status?.last_error" class="collector-error" type="error" :closable="false" :title="`日志写入暂时异常：${status.last_error}`" />
      <el-alert v-else-if="status?.dropped_count && Number(status.dropped_count) > 0" class="collector-error" type="warning" :closable="false" title="收集器队列曾达到上限，部分 UDP 日志可能未写入。" />
    </el-card>

    <div class="results-meta">
      <span class="result-total"><el-icon><List /></el-icon><strong>搜索结果</strong> · {{ result?.total ?? 0 }} 条</span>
      <span class="results-spacer" />
      <span><el-icon><Clock /></el-icon>按平台接收时间倒序 · 最近收到 {{ lastReceived }}</span>
    </div>

    <div class="syslog-layout">
      <el-card class="results-card" shadow="never" :body-style="{ padding: '0' }">
        <el-table
          :data="result?.items || []"
          row-key="id"
          highlight-current-row
          :current-row-key="selected?.id"
          empty-text="所选时间段没有日志"
          @row-click="selected = $event"
        >
          <el-table-column min-width="170">
            <template #header><span class="table-heading"><el-icon><Clock /></el-icon>接收时间</span></template>
            <template #default="{ row }"><span class="timestamp">{{ formatDate(row.received_at) }}</span></template>
          </el-table-column>
          <el-table-column width="105">
            <template #header><span class="table-heading"><el-icon><WarningFilled /></el-icon>级别</span></template>
            <template #default="{ row }"><el-tag size="small" :type="severityType(row.severity)" effect="light">{{ severityName(row.severity) }}</el-tag></template>
          </el-table-column>
          <el-table-column min-width="160" show-overflow-tooltip>
            <template #header><span class="table-heading"><el-icon><Monitor /></el-icon>来源设备</span></template>
            <template #default="{ row }">
              <el-button v-if="row.device_id" link type="primary" @click.stop="openDevice(row)">{{ row.device_name }}</el-button>
              <span v-else class="unmatched">{{ row.hostname || '未匹配设备' }}</span>
              <div class="source-ip"><el-icon><Location /></el-icon>{{ row.source_ip }}</div>
            </template>
          </el-table-column>
          <el-table-column min-width="145" show-overflow-tooltip>
            <template #header><span class="table-heading"><el-icon><Cpu /></el-icon>Facility / 程序</span></template>
            <template #default="{ row }"><div>{{ facilityName(row.facility) }}</div><div class="source-ip"><el-icon><Operation /></el-icon>{{ row.app_name || '—' }}<span v-if="row.procid"> · PID {{ row.procid }}</span></div></template>
          </el-table-column>
          <el-table-column min-width="260" show-overflow-tooltip>
            <template #header><span class="table-heading"><el-icon><ChatLineRound /></el-icon>消息摘要</span></template>
            <template #default="{ row }"><span class="message-text"><el-icon><ChatLineRound /></el-icon>{{ row.message }}</span></template>
          </el-table-column>
        </el-table>
        <div class="pagination-row">
          <span>第 {{ page }} / {{ pageCount }} 页 · 每页 {{ pageSize }} 条</span>
          <el-pagination
            small
            background
            layout="prev, pager, next"
            :current-page="page"
            :page-size="pageSize"
            :total="result?.total || 0"
            @current-change="changePage"
          />
        </div>
      </el-card>

      <el-card class="detail-card" shadow="never">
        <template #header><div class="detail-title"><span><el-icon><Document /></el-icon>日志详情</span><el-tag v-if="selected" size="small" effect="plain">#{{ selected.id }}</el-tag></div></template>
        <el-empty v-if="!selected" :image-size="64" description="选择一条日志查看详细信息" />
        <template v-else>
          <div class="detail-severity"><el-tag :type="severityType(selected.severity)" effect="light">{{ severityName(selected.severity) }}</el-tag><span><el-icon><Clock /></el-icon>{{ formatDate(selected.received_at) }}</span></div>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="来源设备">
              <template #label><span class="description-label"><el-icon><Monitor /></el-icon>来源设备</span></template>
              <el-button v-if="selected.device_id" link type="primary" @click="openDevice(selected)">{{ selected.device_name }}</el-button>
              <span v-else>{{ selected.hostname || '未匹配设备' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="来源地址"><template #label><span class="description-label"><el-icon><Location /></el-icon>来源地址</span></template>{{ selected.source_ip }}</el-descriptions-item>
            <el-descriptions-item label="设备时间"><template #label><span class="description-label"><el-icon><Clock /></el-icon>设备时间</span></template>{{ formatDate(selected.reported_at) }}</el-descriptions-item>
            <el-descriptions-item label="Facility"><template #label><span class="description-label"><el-icon><Cpu /></el-icon>Facility</span></template>{{ facilityName(selected.facility) }}</el-descriptions-item>
            <el-descriptions-item label="程序 / PID"><template #label><span class="description-label"><el-icon><Operation /></el-icon>程序 / PID</span></template>{{ selected.app_name || '—' }}<span v-if="selected.procid"> / {{ selected.procid }}</span></el-descriptions-item>
            <el-descriptions-item label="消息 ID"><template #label><span class="description-label"><el-icon><ChatLineRound /></el-icon>消息 ID</span></template>{{ selected.msgid || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div class="raw-heading"><el-icon><Document /></el-icon> 原始消息</div>
          <pre class="raw-message">{{ selected.raw_message }}</pre>
          <div v-if="selected.structured_data" class="raw-heading">Structured Data</div>
          <pre v-if="selected.structured_data" class="raw-message">{{ selected.structured_data }}</pre>
          <div v-if="!selected.parsed" class="parse-note">消息未完全符合 RFC 3164 / RFC 5424 格式，已保留原始内容。</div>
        </template>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.syslog-toolbar-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.page-title { display: flex; align-items: center; gap: 8px; }
.page-title-icon { color: var(--el-color-primary); }
.status-icon { margin-right: 4px; vertical-align: -2px; }
.syslog-stats { margin-top: 4px; }
.syslog-stats .el-card { height: 88px; }
.syslog-stats .el-card :deep(.el-card__body) { display: grid; grid-template-columns: 1fr auto; align-items: center; column-gap: 9px; height: 100%; padding: 13px 16px; }
.syslog-stats .stat-label { display: inline-flex; align-items: center; gap: 6px; color: var(--el-text-color-secondary); font-size: 13px; }
.syslog-stats .stat-label .el-icon { color: var(--el-color-primary); font-size: 15px; }
.syslog-stats .el-col:nth-child(2) .stat-label .el-icon { color: var(--el-color-danger); }
.syslog-stats .el-col:nth-child(3) .stat-label .el-icon { color: var(--el-color-warning); }
.syslog-stats strong { grid-row: span 2; color: var(--el-color-primary); font-size: 25px; font-weight: 650; }
.syslog-stats small { color: var(--el-text-color-secondary); font-size: 12px; }
.syslog-stats .text-danger { color: var(--el-color-danger); }
.syslog-stats .text-warning { color: var(--el-color-warning); }
.syslog-stats .last-received { max-width: 210px; font-size: 14px; text-align: right; }
.search-panel :deep(.el-card__body) { padding: 15px; }
.search-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.search-query { flex: 1 1 270px; min-width: 220px; }
.search-controls > .el-select { width: 160px; }
.search-controls > .range-select { width: 145px; }
.search-controls > .el-date-editor { flex: 1 1 320px; max-width: 390px; }
.quick-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
.muted-label, .collector-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.muted-label { display: inline-flex; align-items: center; gap: 4px; }
.collector-meta { margin-left: auto; }
.collector-error { margin-top: 12px; }
.results-meta { display: flex; align-items: center; gap: 7px; margin: 16px 2px 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.results-meta strong { color: var(--el-text-color-primary); font-size: 14px; }
.results-meta > span:not(.results-spacer) { display: inline-flex; align-items: center; gap: 5px; }
.results-meta .el-icon { color: var(--el-color-primary); }
.results-spacer { flex: 1; }
.syslog-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 34%); align-items: start; gap: 14px; }
.results-card, .detail-card { min-width: 0; }
.results-card :deep(.el-card__body) { padding: 0; }
.timestamp { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.source-ip { display: flex; align-items: center; gap: 4px; margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.message-text { display: inline-flex; align-items: flex-start; gap: 5px; color: var(--el-text-color-primary); }
.table-heading, .description-label { display: inline-flex; align-items: center; gap: 5px; }
.table-heading .el-icon, .description-label .el-icon { color: var(--el-text-color-secondary); }
.unmatched { color: var(--el-text-color-secondary); }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; padding: 8px 14px; border-top: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }
.detail-card :deep(.el-card__header) { padding: 14px 16px; }
.detail-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 650; }
.detail-title > span, .detail-severity > span { display: inline-flex; align-items: center; gap: 5px; }
.detail-title > span .el-icon { color: var(--el-color-primary); }
.detail-severity { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 13px; color: var(--el-text-color-secondary); font-size: 12px; }
.raw-heading { display: flex; align-items: center; gap: 6px; margin: 16px 0 7px; color: var(--el-text-color-secondary); font-size: 12px; font-weight: 600; }
.raw-message { max-height: 210px; overflow: auto; margin: 0; padding: 10px; border-radius: 7px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font: 12px/1.55 Consolas, Monaco, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.parse-note { margin-top: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.page-subtitle { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
@media (max-width: 1200px) {
  .syslog-layout { grid-template-columns: minmax(0, 1fr); }
  .detail-card { order: -1; }
}
@media (max-width: 700px) {
  .syslog-toolbar-actions { width: 100%; justify-content: flex-start; }
  .search-controls > .el-select, .search-controls > .range-select { flex: 1 1 calc(50% - 10px); width: auto; }
  .search-query { flex-basis: 100%; }
  .search-controls > .el-date-editor { max-width: none; }
  .collector-meta { flex-basis: 100%; margin-left: 0; }
  .results-meta { align-items: flex-start; }
  .results-meta > span:last-child { max-width: 50%; text-align: right; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
}
</style>
