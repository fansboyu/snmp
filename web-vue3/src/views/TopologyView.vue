<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { Graph } from '@antv/x6'
import type { EChartsOption } from 'echarts'
import { ElMessage, ElMessageBox } from 'element-plus'
import EChartCard from '../components/EChartCard.vue'
import { formatRate, localTime, dataStatusNames } from '../services/traffic-format'
import {
  getDefaultTopology,
  syncAutoTopology,
  createTopologyNode,
  createTopologyLink,
  deleteTopologyNode,
  deleteTopologyLink,
  saveTopologyLayout,
  getTopologyLayoutPreview,
  getTopologyDetail,
  getTopologyTraffic,
  getTopologyHistory,
  setTopologyNode,
  setTopologyLink,
  bindTopologyNeighbor,
  requestTopologyScan,
  type TopologyData,
  type TopologyNode,
  type TopologyLink,
  type TopologyDetail,
  type TopologyFlow,
  type TopologyChange,
  type DeviceNeighbor,
} from '../services/api'

const router = useRouter()
const canvas = ref<HTMLDivElement>()
const data = ref<TopologyData | null>(null)
const editing = ref(false),
  dirty = ref(false),
  busy = ref(false),
  loading = ref(false)
const maximized = ref(false),
  autoRefresh = ref(true),
  collapseBundles = ref(true)
const group = ref('all'),
  keyword = ref(''),
  selectedId = ref(''),
  selectedKind = ref('')
const flows = ref<Record<string, TopologyFlow>>({}),
  flowError = ref(''),
  refreshedAt = ref('')
const detail = ref<TopologyDetail | null>(null),
  detailLoading = ref(false),
  range = ref('1h')
const history = ref<TopologyChange[]>([]),
  historyVisible = ref(false)
const discoveryVisible = ref(false)
const scanSubmitting = ref('')
const discoveryNames: Record<string, string> = {
  waiting: '等待采集',
  disabled: '已停用',
  stale: '结果过期',
  success: '读取成功',
  partial: '部分成功',
  failed: '查询失败',
  unsupported: '不支持或不可见',
  pending: '排队中',
  running: '采集中',
  expired: '排队超时',
}
async function scanDevice(id: string) {
  scanSubmitting.value = id
  try {
    await requestTopologyScan(id)
    ElMessage.success('已提交邻居采集，将由采集器按设备串行执行')
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败')
  } finally {
    scanSubmitting.value = ''
  }
}
const nodeDevice = ref(''),
  customLabel = ref('')
const linkForm = reactive({ source_node_id: '', target_node_id: '', label: '' })
const nodeForm = reactive({ label: '', layer: 'access', position_locked: false })
const bindingForm = reactive({
  source_interface_id: '',
  target_interface_id: '',
  label: '',
  bundle_id: '',
})
const neighborDialog = ref(false),
  neighbor = ref<DeviceNeighbor | null>(null)
const neighborForm = reactive({ device: '', port: '' })
let graph: Graph | null = null,
  rendering = false,
  disposed = false,
  loadSequence = 0,
  detailSequence = 0
let detailAbort: AbortController | undefined, flowAbort: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
const statusNames: Record<string, string> = {
  online: '在线',
  offline: '离线',
  checking: '正在确认',
  collection_error: '采集异常',
  unknown: '状态未知',
  pending: '等待首次采集',
  disabled: '已停用',
  up: '正常',
  down: '异常',
  stale: '证据过期',
  unconfirmed: '待确认',
  degraded: '部分成员异常',
}
const scanNames: Record<string, string> = {
  success: '完整成功',
  empty: '成功·无邻居',
  partial: '部分成功',
  failed: '失败',
  unsupported: '不支持或不可见',
}
const layerNames: Record<string, string> = {
  core: '核心',
  aggregation: '汇聚',
  access: '接入',
  external: '外部/区域',
}
const nodes = computed(() => data.value?.nodes || [])
const links = computed(() => data.value?.links || [])
const ports = computed(() => data.value?.ports || [])
const devices = computed(() => data.value?.devices || [])
const unmatched = computed(() =>
  (data.value?.neighbors || []).filter((n) => n.match_state !== 'matched'),
)
const groups = computed(
  () => [...new Set(devices.value.map((d) => d.group_name).filter(Boolean))] as string[],
)
const selectedNode = computed(() =>
  selectedKind.value === 'node'
    ? nodes.value.find((n) => String(n.id) === selectedId.value)
    : undefined,
)
const selectedLink = computed(() =>
  selectedKind.value === 'link'
    ? links.value.find((l) => String(l.id) === selectedId.value)
    : undefined,
)
const visibleNodes = computed(() =>
  nodes.value.filter(
    (n) =>
      (group.value === 'all' || n.group_name === group.value) &&
      `${n.label} ${n.device_host || ''}`
        .toLowerCase()
        .includes(keyword.value.trim().toLowerCase()),
  ),
)
const visibleLinks = computed(() => {
  const ids = new Set(visibleNodes.value.map((n) => String(n.id)))
  return links.value.filter(
    (l) =>
      ids.has(String(l.source_node_id)) &&
      ids.has(String(l.target_node_id)) &&
      (!collapseBundles.value ||
        !l.bundle_id ||
        !links.value.some((p) => String(p.id) === String(l.bundle_id))),
  )
})
const unusedDevices = computed(() =>
  devices.value.filter((d) => !nodes.value.some((n) => String(n.device_id) === String(d.id))),
)
const sourceNode = computed(() =>
  nodes.value.find((n) => String(n.id) === String(selectedLink.value?.source_node_id)),
)
const targetNode = computed(() =>
  nodes.value.find((n) => String(n.id) === String(selectedLink.value?.target_node_id)),
)
const sourcePorts = computed(() =>
  ports.value.filter((p) => String(p.device_id) === String(sourceNode.value?.device_id)),
)
const targetPorts = computed(() =>
  ports.value.filter((p) => String(p.device_id) === String(targetNode.value?.device_id)),
)
const neighborPorts = computed(() =>
  ports.value.filter((p) => String(p.device_id) === neighborForm.device),
)
const bundleOptions = computed(() =>
  links.value.filter(
    (l) =>
      l.id !== selectedLink.value?.id &&
      !l.bundle_id &&
      ((l.source_node_id === selectedLink.value?.source_node_id &&
        l.target_node_id === selectedLink.value?.target_node_id) ||
        (l.target_node_id === selectedLink.value?.source_node_id &&
          l.source_node_id === selectedLink.value?.target_node_id)),
  ),
)
const portLabel = (p: { if_name?: string | null; if_descr?: string | null; if_index?: number }) =>
  p.if_name || p.if_descr || `ifIndex ${p.if_index}`
const color = (status?: string) =>
  status === 'online' || status === 'up'
    ? '#16a34a'
    : status === 'offline' || status === 'down'
      ? '#dc2626'
      : ['checking', 'collection_error', 'stale', 'unconfirmed', 'degraded'].includes(status || '')
        ? '#d97706'
        : '#94a3b8'
const tagType = (status?: string): 'success' | 'danger' | 'warning' | 'info' =>
  status === 'online' || status === 'up'
    ? 'success'
    : status === 'offline' || status === 'down'
      ? 'danger'
      : ['checking', 'collection_error', 'stale', 'unconfirmed', 'degraded'].includes(status || '')
        ? 'warning'
        : 'info'

async function action(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try {
    await work()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close')
      ElMessage.error(error instanceof Error ? error.message : '操作失败')
  } finally {
    busy.value = false
  }
}
async function load(force = false) {
  if (disposed || (!force && dirty.value)) return
  const sequence = ++loadSequence
  loading.value = true
  try {
    const result = await getDefaultTopology()
    if (disposed || sequence !== loadSequence || (!force && dirty.value)) return
    data.value = result
    refreshedAt.value = new Date().toISOString()
    render()
    await refreshTraffic()
    if (selectedLink.value) await loadDetail()
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : '加载拓扑失败')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
function rate(link: TopologyLink): { in: number | null; out: number | null; hint: string } {
  const members = links.value.filter((l) => String(l.bundle_id) === String(link.id))
  if (members.length && !link.source_interface_id && !link.target_interface_id) {
    const values = members.map((m) => {
      const r = rate(m)
      return m.source_node_id === link.source_node_id ? r : { in: r.out, out: r.in, hint: r.hint }
    })
    return {
      in: values.every((v) => v.in !== null) ? values.reduce((s, v) => s + v.in!, 0) : null,
      out: values.every((v) => v.out !== null) ? values.reduce((s, v) => s + v.out!, 0) : null,
      hint: `聚合 ${members.length} 条成员，仅单端计数`,
    }
  }
  const flow = flows.value[String(link.id)],
    summary = flow?.source || flow?.target
  if (!summary || summary.data_status !== 'fresh')
    return {
      in: null,
      out: null,
      hint: summary ? dataStatusNames[summary.data_status] : '无有效流量',
    }
  return flow?.source
    ? { in: summary.in_bps, out: summary.out_bps, hint: 'A 端参考' }
    : { in: summary.out_bps, out: summary.in_bps, hint: 'B 端反向参考' }
}
function edgeText(link: TopologyLink) {
  const r = rate(link)
  return `${link.label || '未命名链路'}\n${statusNames[link.status] || link.status} · ↓${formatRate(r.in)} ↑${formatRate(r.out)}`
}
function render() {
  if (!graph || !data.value) return
  rendering = true
  const expected = new Set([
    ...nodes.value.map((n) => `node-${n.id}`),
    ...links.value.map((l) => `link-${l.id}`),
  ])
  for (const cell of graph.getCells()) if (!expected.has(cell.id)) graph.removeCell(cell)
  const visible = new Set(visibleNodes.value.map((n) => String(n.id)))
  for (const n of nodes.value) {
    let cell = graph.getCellById(`node-${n.id}`)
    const label = `${n.position_locked ? '🔒 ' : ''}${n.label}\n${n.device_host || layerNames[n.layer || 'access']} · ${statusNames[n.device_status || 'unknown']}`
    if (!cell)
      cell = graph.addNode({
        id: `node-${n.id}`,
        shape: 'rect',
        x: Number(n.x),
        y: Number(n.y),
        width: Number(n.width),
        height: Number(n.height),
        data: { backendId: String(n.id) },
        ports: {
          groups: {
            left: {
              position: 'left',
              attrs: { circle: { r: 4, magnet: true, stroke: '#2563eb', fill: '#fff' } },
            },
            right: {
              position: 'right',
              attrs: { circle: { r: 4, magnet: true, stroke: '#2563eb', fill: '#fff' } },
            },
          },
          items: [
            { id: 'left', group: 'left' },
            { id: 'right', group: 'right' },
          ],
        },
      })
    cell.attr({
      body: {
        rx: 9,
        ry: 9,
        fill: n.device_id ? '#eff6ff' : '#f8fafc',
        stroke: color(n.device_status),
        strokeWidth: selectedId.value === String(n.id) && selectedKind.value === 'node' ? 3 : 1.8,
      },
      label: {
        text: label,
        fill: '#172033',
        fontSize: 12,
        textWrap: { width: -12, height: -10, ellipsis: true },
      },
    })
    if (cell.isNode())
      for (const p of cell.getPorts())
        cell.portProp(p.id!, 'attrs/circle/opacity', editing.value ? 1 : 0)
    visible.has(String(n.id)) ? cell.show() : cell.hide()
  }
  const visibleEdges = new Set(visibleLinks.value.map((l) => String(l.id)))
  // Distinct vertices keep real parallel links separate.
  const pairs = new Map<string, TopologyLink[]>()
  for (const l of links.value) {
    const key = [l.source_node_id, l.target_node_id].sort().join(':')
    if (!pairs.has(key)) pairs.set(key, [])
    pairs.get(key)!.push(l)
  }
  for (const l of links.value) {
    let edge = graph.getCellById(`link-${l.id}`)
    if (!edge)
      edge = graph.addEdge({
        id: `link-${l.id}`,
        source: `node-${l.source_node_id}`,
        target: `node-${l.target_node_id}`,
        data: { backendId: String(l.id) },
        zIndex: 0,
        connector: { name: 'rounded' },
      })
    if (!edge.isEdge()) continue
    edge.setSource({ cell: `node-${l.source_node_id}` })
    edge.setTarget({ cell: `node-${l.target_node_id}` })
    edge.attr({
      line: {
        stroke: color(l.status),
        strokeWidth: l.bundle_id ? 1.5 : 2.2,
        strokeDasharray: ['stale', 'unconfirmed', 'unknown'].includes(l.status) ? '6 4' : '',
        targetMarker: null,
      },
    })
    const siblings = pairs.get([l.source_node_id, l.target_node_id].sort().join(':')) || []
    edge.setLabels([
      {
        position: {
          distance:
            siblings.length > 1 ? 0.32 + (0.36 * siblings.indexOf(l)) / (siblings.length - 1) : 0.5,
        },
        attrs: {
          label: { text: edgeText(l), fontSize: 10, fill: '#334155' },
          body: { fill: '#ffffff', stroke: '#e2e8f0' },
        },
      },
    ])
    const a = graph.getCellById(`node-${l.source_node_id}`),
      b = graph.getCellById(`node-${l.target_node_id}`)
    if (siblings.length > 1 && a?.isNode() && b?.isNode()) {
      const ca = a.getBBox().center,
        cb = b.getBBox().center,
        offset = (siblings.indexOf(l) - (siblings.length - 1) / 2) * 65
      const distance = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1
      edge.setVertices([
        {
          x: (ca.x + cb.x) / 2 - ((cb.y - ca.y) / distance) * offset,
          y: (ca.y + cb.y) / 2 + ((cb.x - ca.x) / distance) * offset,
        },
      ])
    } else edge.setVertices([])
    visibleEdges.has(String(l.id)) ? edge.show() : edge.hide()
  }
  rendering = false
}
async function refreshTraffic() {
  flowAbort?.abort()
  const controller = new AbortController()
  flowAbort = controller
  const relevant = new Set(visibleLinks.value.map((l) => String(l.id)))
  for (const l of links.value)
    if (l.bundle_id && relevant.has(String(l.bundle_id))) relevant.add(String(l.id))
  const ids = [...relevant],
    next: Record<string, TopologyFlow> = {}
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await getTopologyTraffic(ids.slice(i, i + 100), controller.signal)
      for (const row of rows) next[String(row.id)] = row
    }
    if (disposed || controller.signal.aborted) return
    flows.value = next
    flowError.value = ''
    render()
  } catch (error) {
    if (controller.signal.aborted || disposed) return
    flows.value = {}
    flowError.value = error instanceof Error ? error.message : '流量更新失败'
    render()
  }
}
async function loadDetail() {
  const link = selectedLink.value
  if (!link) {
    detail.value = null
    return
  }
  const sequence = ++detailSequence
  detailAbort?.abort()
  const controller = new AbortController()
  detailAbort = controller
  detailLoading.value = true
  try {
    const result = await getTopologyDetail(String(link.id), range.value, controller.signal)
    if (!disposed && sequence === detailSequence) detail.value = result
  } catch (error) {
    if (!controller.signal.aborted && !disposed) {
      detail.value = null
      ElMessage.error(error instanceof Error ? error.message : '详情加载失败')
    }
  } finally {
    if (sequence === detailSequence) detailLoading.value = false
  }
}
function select(kind: string, id: string) {
  selectedKind.value = kind
  selectedId.value = id
  detail.value = null
  if (kind === 'node') {
    const n = selectedNode.value
    if (n)
      Object.assign(nodeForm, {
        label: n.label,
        layer: n.layer || 'access',
        position_locked: !!n.position_locked,
      })
  } else {
    const l = selectedLink.value
    if (l) {
      Object.assign(bindingForm, {
        source_interface_id: l.source_interface_id || '',
        target_interface_id: l.target_interface_id || '',
        label: l.label || '',
        bundle_id: l.bundle_id || '',
      })
      void loadDetail()
    }
  }
  render()
}
async function switchMode() {
  await action(async () => {
    if (editing.value && dirty.value) {
      await ElMessageBox.confirm('布局尚未保存，是否放弃本次位置调整？', '退出编辑', {
        type: 'warning',
      })
      dirty.value = false
      graph?.clearCells()
      await load(true)
    }
    editing.value = !editing.value
    render()
  })
}
async function saveLayout() {
  await action(async () => {
    if (!graph) return
    const result = await saveTopologyLayout(
      graph
        .getNodes()
        .map((n) => ({ id: n.id.replace('node-', ''), ...n.position(), ...n.size() })),
    )
    data.value = result
    dirty.value = false
    render()
    ElMessage.success('布局已保存')
  })
}
async function previewLayout() {
  await action(async () => {
    const positions = await getTopologyLayoutPreview()
    rendering = true
    for (const n of positions) {
      const cell = graph?.getCellById(`node-${n.id}`)
      if (cell?.isNode()) cell.position(Number(n.x), Number(n.y))
    }
    rendering = false
    dirty.value = true
    render()
    graph?.zoomToFit({ padding: 40, maxScale: 1 })
  })
}
async function sync() {
  await action(async () => {
    if (dirty.value) throw Error('请先保存布局，再同步发现结果')
    await syncAutoTopology()
    await load(true)
    ElMessage.success('已同步数据库中的发现证据；未触发即时扫描')
  })
}
function newPosition() {
  const count = nodes.value.length
  return { x: 80 + (count % 4) * 240, y: 80 + Math.floor(count / 4) * 150 }
}
async function addNode(custom = false) {
  await action(async () => {
    const d = devices.value.find((d) => String(d.id) === nodeDevice.value)
    if (custom && !customLabel.value.trim()) throw Error('请输入区域名称')
    if (!custom && !d) throw Error('请选择设备')
    await createTopologyNode({
      device_id: custom ? null : d!.id,
      label: custom ? customLabel.value.trim() : d!.name,
      node_type: custom ? 'network' : 'device',
      ...newPosition(),
    })
    customLabel.value = ''
    nodeDevice.value = ''
    await load(true)
  })
}
async function addLink() {
  await action(async () => {
    if (
      !linkForm.source_node_id ||
      !linkForm.target_node_id ||
      linkForm.source_node_id === linkForm.target_node_id
    )
      throw Error('请选择两个不同节点')
    await createTopologyLink({ ...linkForm, link_type: 'manual', status: 'unknown' })
    await load(true)
  })
}
async function removeSelected() {
  await action(async () => {
    if (!selectedId.value) return
    await ElMessageBox.confirm('确认删除选中元素？自动链路删除后会停止自动重建。', '删除拓扑元素', {
      type: 'warning',
    })
    if (selectedKind.value === 'node') await deleteTopologyNode(selectedId.value)
    else await deleteTopologyLink(selectedId.value)
    selectedId.value = ''
    await load(true)
  })
}
async function saveNode() {
  await action(async () => {
    if (!selectedNode.value) return
    await setTopologyNode(selectedId.value, {
      label: nodeForm.label,
      layer: nodeForm.layer as TopologyNode['layer'],
      position_locked: nodeForm.position_locked,
    })
    await load(true)
    ElMessage.success('节点设置已保存')
  })
}
async function saveBinding() {
  await action(async () => {
    if (!selectedLink.value) return
    await setTopologyLink(selectedId.value, {
      ...bindingForm,
      source_interface_id: bindingForm.source_interface_id || null,
      target_interface_id: bindingForm.target_interface_id || null,
      bundle_id: bindingForm.bundle_id || null,
    })
    await load(true)
    ElMessage.success('人工绑定已保存，自动同步不会覆盖')
  })
}
function openNeighbor(n: DeviceNeighbor) {
  neighbor.value = n
  neighborForm.device = ''
  neighborForm.port = ''
  neighborDialog.value = true
}
async function confirmNeighbor() {
  await action(async () => {
    if (!neighbor.value || !neighborForm.device) throw Error('请选择匹配的已纳管设备')
    await bindTopologyNeighbor(neighbor.value.id, neighborForm.device, neighborForm.port)
    neighborDialog.value = false
    await load(true)
  })
}
async function showHistory() {
  await action(async () => {
    history.value = await getTopologyHistory()
    historyVisible.value = true
  })
}
async function moreHistory() {
  await action(async () => {
    if (history.value.length)
      history.value.push(...(await getTopologyHistory(history.value[history.value.length - 1].id)))
  })
}
function historyAction(value: string) {
  return (
    (
      { insert: '新增', update: '修改', delete: '删除', confirm: '确认匹配' } as Record<
        string,
        string
      >
    )[value] || value
  )
}
function fitView() {
  graph?.zoomToFit({ padding: 40, maxScale: 1 })
}
const trafficChart = computed<EChartsOption>(() => {
  const first = detail.value?.traffic[0]
  return {
    color: ['#2563eb', '#0f9f82'],
    tooltip: { trigger: 'axis' },
    legend: { data: ['入方向', '出方向'] },
    grid: { left: 65, right: 15, top: 40, bottom: 35 },
    xAxis: { type: 'category', data: first?.points.map((p) => localTime(p.time)) || [] },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => formatRate(v) } },
    series: [
      {
        name: '入方向',
        type: 'line',
        showSymbol: false,
        connectNulls: false,
        data: first?.points.map((p) => p.in_bps),
      },
      {
        name: '出方向',
        type: 'line',
        showSymbol: false,
        connectNulls: false,
        data: first?.points.map((p) => p.out_bps),
      },
    ],
  }
})
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('布局未保存，是否离开？', '未保存布局')
    return true
  } catch {
    return false
  }
})
watch([group, keyword, collapseBundles], () => {
  render()
  void refreshTraffic()
})
watch(
  () => neighborForm.device,
  () => {
    neighborForm.port = ''
  },
)
onMounted(async () => {
  await nextTick()
  graph = new Graph({
    container: canvas.value!,
    autoResize: true,
    grid: { visible: true, size: 16 },
    background: { color: '#f8fafc' },
    panning: true,
    mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'], minScale: 0.2, maxScale: 2 },
    interacting: (cell) =>
      editing.value &&
      !(
        cell.cell.isNode() &&
        nodes.value.find((n) => `node-${n.id}` === cell.cell.id)?.position_locked
      ),
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowNode: false,
      validateConnection: () => editing.value,
      createEdge: () => graph!.createEdge({ shape: 'edge' }),
    },
  })
  graph.on('cell:click', ({ cell }) =>
    select(cell.isNode() ? 'node' : 'link', String(cell.getData()?.backendId || '')),
  )
  graph.on('blank:click', () => {
    selectedId.value = ''
    selectedKind.value = ''
    detailAbort?.abort()
    render()
  })
  graph.on('node:change:position', () => {
    if (!rendering && editing.value) dirty.value = true
  })
  graph.on('edge:connected', ({ edge }) => {
    if (rendering || edge.getData()?.backendId || !editing.value) return
    void action(async () => {
      try {
        await createTopologyLink({
          source_node_id: edge.getSourceCellId()!.replace('node-', ''),
          target_node_id: edge.getTargetCellId()!.replace('node-', ''),
          link_type: 'manual',
          status: 'unknown',
        })
        await load(true)
      } finally {
        if (graph?.hasCell(edge)) graph.removeCell(edge)
      }
    })
  })
  await load(true)
  graph.zoomToFit({ padding: 40, maxScale: 1 })
  timer = setInterval(() => {
    const pending = (data.value?.discovery?.summary.pending || 0) > 0
    if (
      (autoRefresh.value || pending) &&
      !document.hidden &&
      !editing.value &&
      !loading.value &&
      !busy.value &&
      (pending || Date.now() - Date.parse(refreshedAt.value) > 28000)
    )
      void load()
  }, 5000)
})
onBeforeUnmount(() => {
  disposed = true
  loadSequence++
  detailSequence++
  clearInterval(timer)
  detailAbort?.abort()
  flowAbort?.abort()
  graph?.dispose()
  graph = null
})
watch(maximized, async () => {
  await nextTick()
  graph?.resize()
})
</script>

<template>
  <div class="topology-page" :class="{ 'topology-max': maximized }">
    <div class="page-toolbar">
      <div>
        <h2 class="page-title">网络拓扑</h2>
        <p class="page-subtitle">
          连接证据、端口状态与流量独立呈现 · 状态刷新 {{ localTime(refreshedAt) }}
        </p>
      </div>
      <div class="topology-tools">
        <el-switch v-model="autoRefresh" active-text="30 秒更新" /><el-button
          @click="discoveryVisible = true"
          >发现诊断 / 立即采集</el-button
        ><el-button @click="showHistory">变更记录</el-button
        ><el-button :loading="loading" :disabled="dirty || busy" @click="load()">刷新状态</el-button
        ><el-button :type="editing ? 'warning' : 'primary'" @click="switchMode">{{
          editing ? '退出编辑' : '编辑拓扑'
        }}</el-button
        ><el-button @click="maximized = !maximized">{{
          maximized ? '退出最大化' : '最大化'
        }}</el-button>
      </div>
    </div>
    <el-alert v-if="data?.discovery" type="info" :closable="false" class="discovery-summary">
      <template #title
        >邻居发现：启用 {{ data.discovery.summary.total }} 台 · 已尝试
        {{ data.discovery.summary.attempted }} 台 · 当前读取成功
        {{ data.discovery.summary.successful }} 台 · 排队/采集中
        {{ data.discovery.summary.pending }} 台</template
      >
      有效证据 {{ data.discovery.summary.evidence }} 条 · 待确认邻居
      {{ data.discovery.summary.unmatched }} 条 · 端口映射不完整
      {{ data.discovery.summary.unmapped_ports }} 条 · 当前自动连接
      {{ data.discovery.summary.links }} 条。
      同步结果不会立即扫描网络；需要重新读取时请使用“发现诊断 / 立即采集”。
    </el-alert>
    <el-alert
      v-if="dirty"
      type="warning"
      :closable="false"
      title="布局尚未保存；自动刷新已暂停。"
    />
    <el-alert
      v-if="flowError"
      type="warning"
      :closable="false"
      :title="`流量读取失败：${flowError}；不影响连接状态判定`"
    />
    <div class="topology-filter">
      <el-input
        v-model="keyword"
        clearable
        placeholder="定位设备名称或 IP"
        style="width: 230px"
      /><el-select v-model="group" style="width: 180px"
        ><el-option label="全部设备分组" value="all" /><el-option
          v-for="g in groups"
          :key="g"
          :label="g"
          :value="g" /></el-select
      ><el-checkbox v-model="collapseBundles">折叠聚合成员</el-checkbox
      ><el-button @click="fitView">适配视图</el-button
      ><span>{{ visibleNodes.length }} 节点 / {{ visibleLinks.length }} 链路</span
      ><span class="legend"
        ><i style="background: #16a34a" />正常 <i style="background: #dc2626" />异常
        <i style="background: #d97706" />过期/待确认
        <i style="background: #94a3b8" />未知/停用</span
      >
    </div>
    <div v-if="editing" class="edit-bar">
      <el-button :loading="busy" @click="sync">同步发现结果</el-button
      ><el-button @click="previewLayout">自动布局预览</el-button
      ><el-button type="primary" :disabled="!dirty" @click="saveLayout">保存布局</el-button
      ><el-button type="danger" plain :disabled="!selectedId" @click="removeSelected"
        >删除选中</el-button
      ><span>同步使用已保存邻居，不会立即扫描；锁定节点保持原位。</span>
    </div>
    <div class="topology-workspace">
      <div class="topology-canvas-wrap">
        <div ref="canvas" class="topology-canvas" />
        <div v-if="!nodes.length" class="canvas-empty">
          <el-empty description="尚无拓扑，进入编辑模式添加设备或同步发现结果" />
        </div>
      </div>
      <aside class="topology-sidebar">
        <el-card v-if="editing" shadow="never"
          ><template #header>添加元素</template
          ><el-select v-model="nodeDevice" filterable clearable placeholder="选择已纳管设备"
            ><el-option
              v-for="d in unusedDevices"
              :key="d.id"
              :label="`${d.name} · ${d.host}`"
              :value="String(d.id)" /></el-select
          ><el-button :disabled="!nodeDevice" @click="addNode()">添加设备</el-button
          ><el-input v-model="customLabel" placeholder="区域 / Internet 等自定义节点" /><el-button
            @click="addNode(true)"
            >添加区域节点</el-button
          ><el-divider /><el-select v-model="linkForm.source_node_id" placeholder="A 端节点"
            ><el-option
              v-for="n in nodes"
              :key="n.id"
              :label="n.label"
              :value="String(n.id)" /></el-select
          ><el-select v-model="linkForm.target_node_id" placeholder="B 端节点"
            ><el-option
              v-for="n in nodes"
              :key="n.id"
              :label="n.label"
              :value="String(n.id)" /></el-select
          ><el-input v-model="linkForm.label" placeholder="链路名 / 聚合名称" /><el-button
            @click="addLink"
            >添加手工连线</el-button
          ></el-card
        >
        <el-card v-if="selectedNode" shadow="never"
          ><template #header>{{ selectedNode.label }}</template
          ><el-tag :type="tagType(selectedNode.device_status)">{{
            statusNames[selectedNode.device_status || 'unknown']
          }}</el-tag>
          <p>{{ selectedNode.device_host || '未纳管 / 自定义节点' }}</p>
          <p>最后采集：{{ localTime(selectedNode.last_sample_at) }}</p>
          <p>{{ selectedNode.probe_reason }}</p>
          <el-button
            v-if="selectedNode.device_id"
            type="primary"
            link
            @click="router.push(`/devices/${selectedNode.device_id}`)"
            >打开设备监控</el-button
          ><template v-if="editing"
            ><el-divider /><el-input v-model="nodeForm.label" placeholder="显示名称" /><el-select
              v-model="nodeForm.layer"
              ><el-option
                v-for="(label, key) in layerNames"
                :key="key"
                :value="key"
                :label="label" /></el-select
            ><el-checkbox v-model="nodeForm.position_locked">锁定节点位置</el-checkbox
            ><el-button @click="saveNode">保存节点设置</el-button></template
          ></el-card
        >
        <el-card v-if="selectedLink" v-loading="detailLoading" shadow="never"
          ><template #header>链路详情</template>
          <h3>{{ selectedLink.label || '未命名链路' }}</h3>
          <el-tag :type="tagType(selectedLink.status)">{{
            statusNames[selectedLink.status]
          }}</el-tag>
          <p>{{ selectedLink.reason }}</p>
          <p>
            A：{{ sourceNode?.label }} · {{ selectedLink.source_interface_name || '端口未绑定' }}
          </p>
          <p>
            B：{{ targetNode?.label }} · {{ selectedLink.target_interface_name || '端口未绑定' }}
          </p>
          <p>
            证据：{{ selectedLink.protocols?.join(' / ') || '手工' }} ·
            {{
              selectedLink.confirmation === 'bidirectional'
                ? '双端发现'
                : selectedLink.confirmation === 'single'
                  ? '单端发现'
                  : '人工维护'
            }}
          </p>
          <p>最近发现：{{ localTime(selectedLink.last_seen_at) }}</p>
          <p v-if="selectedLink.binding_locked">人工绑定已锁定，自动同步不会覆盖。</p>
          <template v-for="t in detail?.traffic" :key="t.port.id"
            ><el-divider /><strong
              >{{ portLabel(t.port) }} · {{ formatRate(Number(t.port.speed_bps) || null) }}</strong
            >
            <p>入 {{ formatRate(t.summary.in_bps) }} / 出 {{ formatRate(t.summary.out_bps) }}</p>
            <p>
              利用率：{{
                t.summary.in_utilization == null
                  ? '未知'
                  : t.summary.in_utilization.toFixed(1) + '%'
              }}
              /
              {{
                t.summary.out_utilization == null
                  ? '未知'
                  : t.summary.out_utilization.toFixed(1) + '%'
              }}
            </p>
            <p>
              {{ dataStatusNames[t.summary.data_status] }} · {{ localTime(t.summary.sampled_at) }}
            </p>
            <el-button
              link
              type="primary"
              @click="router.push(`/devices/${t.port.device_id}/interfaces/${t.port.id}`)"
              >查看端口详情</el-button
            ></template
          >
          <template v-if="detail?.traffic.length"
            ><el-radio-group v-model="range" size="small" @change="loadDetail"
              ><el-radio-button value="1h">1 小时</el-radio-button
              ><el-radio-button value="6h">6 小时</el-radio-button
              ><el-radio-button value="24h">24 小时</el-radio-button></el-radio-group
            ><el-empty
              v-if="!detail.traffic[0]?.points.some((p) => p.in_bps != null || p.out_bps != null)"
              description="所选时段暂无有效流量样本"
              :image-size="60" />
            <EChartCard
              v-else
              title="参考端口流量"
              description="以首个绑定端口为参考，两端速率不相加"
              :height="230"
              :options="trafficChart"
          /></template>
          <template v-if="detail?.members.length"
            ><el-divider />聚合成员（人工维护，不推断 LACP）
            <div v-for="m in detail.members" :key="m.id" class="neighbor-item">
              <el-button link @click="select('link', String(m.id))">{{
                m.label || m.id
              }}</el-button>
              <p>
                {{ statusNames[m.status] }} · 入 {{ formatRate(rate(m).in) }} / 出
                {{ formatRate(rate(m).out) }}
              </p>
            </div></template
          >
          <el-divider />相关告警<el-empty
            v-if="!detail?.alerts.length"
            :image-size="40"
            description="暂无相关告警"
          />
          <div v-for="a in detail?.alerts" :key="a.id" class="neighbor-item">
            <strong>{{ a.title }}</strong>
            <p>{{ a.status }} · {{ localTime(a.last_seen_at) }}</p>
          </div>
          <template v-if="editing"
            ><el-divider />人工绑定<el-input
              v-model="bindingForm.label"
              placeholder="链路名称"
            /><el-select
              v-model="bindingForm.source_interface_id"
              clearable
              filterable
              placeholder="绑定 A 端端口"
              ><el-option
                v-for="p in sourcePorts"
                :key="p.id"
                :value="String(p.id)"
                :label="portLabel(p)" /></el-select
            ><el-select
              v-model="bindingForm.target_interface_id"
              clearable
              filterable
              placeholder="绑定 B 端端口"
              ><el-option
                v-for="p in targetPorts"
                :key="p.id"
                :value="String(p.id)"
                :label="portLabel(p)" /></el-select
            ><el-select v-model="bindingForm.bundle_id" clearable placeholder="聚合父链路（可选）"
              ><el-option
                v-for="l in bundleOptions"
                :key="l.id"
                :value="String(l.id)"
                :label="l.label || String(l.id)" /></el-select
            ><el-button type="primary" @click="saveBinding">保存并锁定人工绑定</el-button></template
          >
        </el-card>
        <el-card v-if="!selectedId" shadow="never"
          ><template #header>监控说明</template>
          <p>点击设备或链路查看详情。</p>
          <p>绿色表示最新运行证据正常；黄色表示证据过期或待确认，不能据此认定物理断线。</p>
          <p>箭头速率以 A 端为参考；仅有 B 端时反向展示。聚合仅汇总成员的单端有效速率。</p></el-card
        >
        <el-card shadow="never"
          ><template #header>待匹配邻居 · {{ unmatched.length }}</template
          ><el-empty v-if="!unmatched.length" :image-size="40" description="没有待匹配邻居" />
          <div v-for="n in unmatched" :key="n.id" class="neighbor-item">
            <strong>{{ n.remote_sys_name || n.remote_device_name || n.remote_chassis_id }}</strong>
            <p>
              {{ n.protocol.toUpperCase() }} · {{ n.local_port_descr || n.local_port_id }} →
              {{ n.remote_port_descr || n.remote_port_id }}
            </p>
            <p>
              {{
                n.match_state === 'needs_confirmation'
                  ? '仅短名称相同，需人工确认'
                  : n.match_state === 'conflict'
                    ? '多个候选，需人工确认'
                    : '尚未匹配到已纳管设备'
              }}
              ·
              {{ localTime(n.last_seen_at) }}
            </p>
            <el-button v-if="editing" type="primary" link @click="openNeighbor(n)"
              >确认匹配</el-button
            >
          </div></el-card
        >
        <el-card shadow="never"
          ><template #header>邻居采集状态</template>
          <div v-for="s in data?.scans" :key="`${s.device_id}-${s.protocol}`" class="neighbor-item">
            <strong>{{ s.device_name }} · {{ s.protocol.toUpperCase() }}</strong>
            <p>{{ scanNames[s.status] || s.status }} · {{ s.neighbor_count }} 条</p>
            <p>{{ s.reason }}</p>
            <p>
              最近尝试 {{ localTime(s.checked_at) }}<br />最后完整成功
              {{ localTime(s.last_success_at) }}
            </p>
          </div>
          <el-empty v-if="!data?.scans?.length" :image-size="40" description="等待下一次邻居采集"
        /></el-card>
      </aside>
    </div>
    <el-dialog v-model="discoveryVisible" title="邻居发现诊断" width="min(1100px,95vw)">
      <p>
        采集只读取已纳管设备的 LLDP/CDP。默认邻居周期 10
        分钟；手动请求共用有界工作池，可能需要等待正在执行的设备任务结束。无邻居或协议不可见不代表断线。
      </p>
      <el-table :data="data?.discovery?.devices || []" max-height="540">
        <el-table-column label="设备" min-width="170"
          ><template #default="{ row }"
            ><strong>{{ row.name }}</strong>
            <p>{{ row.host }}</p></template
          ></el-table-column
        >
        <el-table-column label="状态" width="110"
          ><template #default="{ row }">{{
            discoveryNames[row.status] || row.status
          }}</template></el-table-column
        >
        <el-table-column label="诊断详情" min-width="330"
          ><template #default="{ row }">
            <p v-if="row.request">
              最近手动请求：{{ row.request.reason }} · {{ localTime(row.request.created_at) }}
            </p>
            <p v-if="!row.scans.length">
              尚无协议结果；检查采集器是否运行、设备是否启用，以及管理网 SNMP 连通性。
            </p>
            <p v-for="s in row.scans" :key="s.protocol">
              {{ s.protocol.toUpperCase() }}：{{ scanNames[s.status] || s.status }} ·
              {{ s.neighbor_count }} 条 · {{ s.reason }} · {{ localTime(s.checked_at) }}
            </p>
          </template></el-table-column
        >
        <el-table-column label="操作" width="120"
          ><template #default="{ row }"
            ><el-button
              type="primary"
              link
              :loading="scanSubmitting === String(row.id)"
              :disabled="
                !row.enabled || ['pending', 'running'].includes(row.status) || dirty || editing
              "
              @click="scanDevice(String(row.id))"
              >立即采集</el-button
            ></template
          ></el-table-column
        >
      </el-table>
      <template #footer
        ><el-button :disabled="dirty" :loading="loading" @click="load()">刷新诊断</el-button
        ><el-button @click="discoveryVisible = false">关闭</el-button></template
      >
    </el-dialog>
    <el-dialog v-model="neighborDialog" title="确认邻居身份" width="min(540px,95vw)"
      ><p>仅绑定现有设备，不会自动创建监控设备或继承 SNMP 凭据。</p>
      <p v-if="neighbor?.candidates?.length">
        候选：{{ neighbor.candidates.map((c) => c.name).join(' / ') }}
      </p>
      <el-select v-model="neighborForm.device" filterable placeholder="选择真实设备"
        ><el-option
          v-for="d in devices.filter((d) => String(d.id) !== String(neighbor?.device_id))"
          :key="d.id"
          :label="`${d.name} · ${d.host}`"
          :value="String(d.id)" /></el-select
      ><el-select
        v-model="neighborForm.port"
        clearable
        filterable
        placeholder="选择远端端口（可选）"
        ><el-option
          v-for="p in neighborPorts"
          :key="p.id"
          :label="portLabel(p)"
          :value="String(p.id)" /></el-select
      ><template #footer
        ><el-button @click="neighborDialog = false">取消</el-button
        ><el-button type="primary" :loading="busy" @click="confirmNeighbor"
          >保存匹配</el-button
        ></template
      ></el-dialog
    >
    <el-drawer v-model="historyVisible" title="拓扑变更记录" size="min(600px,95vw)"
      ><el-timeline
        ><el-timeline-item v-for="h in history" :key="h.id" :timestamp="localTime(h.created_at)"
          ><strong
            >{{
              h.entity_type === 'topology_nodes'
                ? '节点'
                : h.entity_type === 'topology_links'
                  ? '链路'
                  : '邻居匹配'
            }}
            #{{ h.entity_id }} · {{ historyAction(h.action) }}</strong
          >
          <details>
            <summary>查看前后数据</summary>
            <pre>{{ JSON.stringify({ before: h.before_data, after: h.after_data }, null, 2) }}</pre>
          </details></el-timeline-item
        ></el-timeline
      ><el-button @click="moreHistory">加载更早记录</el-button></el-drawer
    >
  </div>
</template>

<style scoped>
.topology-tools,
.topology-filter,
.edit-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.topology-filter,
.edit-bar {
  padding: 12px 0;
  color: #64748b;
  font-size: 13px;
}
.edit-bar {
  border-top: 1px solid #e2e8f0;
}
.topology-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 370px;
  gap: 16px;
}
.topology-canvas-wrap {
  position: relative;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
}
.topology-canvas {
  height: calc(100vh - 245px);
  min-height: 600px;
  width: 100%;
}
.topology-sidebar {
  display: grid;
  grid-auto-rows: max-content;
  gap: 14px;
  align-content: start;
  max-height: calc(100vh - 245px);
  overflow: auto;
}
.topology-sidebar :deep(.el-card__body) {
  display: grid;
  gap: 9px;
}
.topology-sidebar p {
  font-size: 12px;
  color: #64748b;
  margin: 3px 0;
  line-height: 1.6;
}
.topology-sidebar h3 {
  margin: 0;
  font-size: 16px;
}
.topology-sidebar .el-select,
.topology-sidebar .el-input {
  width: 100%;
}
.neighbor-item {
  padding: 10px 0;
  border-bottom: 1px solid #edf0f4;
  font-size: 13px;
}
.canvas-empty {
  position: absolute;
  inset: 25% 10% auto;
  pointer-events: none;
}
.legend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.topology-max {
  position: fixed;
  inset: 0;
  background: #f3f6fb;
  z-index: 1900;
  padding: 20px;
  overflow: auto;
}
.topology-max .topology-canvas,
.topology-max .topology-sidebar {
  height: calc(100vh - 160px);
  max-height: calc(100vh - 160px);
}
pre {
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.el-dialog .el-select {
  width: 100%;
  margin-top: 12px;
}
@media (max-width: 1100px) {
  .topology-workspace {
    grid-template-columns: 1fr;
  }
  .topology-sidebar {
    max-height: none;
  }
  .topology-canvas {
    min-height: 460px;
  }
  .legend {
    margin-left: 0;
  }
}
</style>
