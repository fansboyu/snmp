<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { Graph, type Cell, type Edge } from '@antv/x6'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FullScreen } from '@element-plus/icons-vue'
import {
  createTopologyLink,
  createTopologyNode,
  deleteTopologyLink,
  deleteTopologyNode,
  getDefaultTopology,
  listDevices,
  listTopologyNeighbors,
  saveTopologyLayout,
  syncAutoTopology,
  type Device,
  type DeviceNeighbor,
  type TopologyData,
  type TopologyLink,
  type TopologyNode
} from '../services/api'

const loading = ref(false)
const saving = ref(false)
const graphContainer = ref<HTMLDivElement>()
const topology = ref<TopologyData | null>(null)
const devices = ref<Device[]>([])
const unmatchedNeighbors = ref<DeviceNeighbor[]>([])
const selectedCell = shallowRef<Cell | null>(null)
const isTopologyMaximized = ref(false)
let graph: Graph | null = null

const addDeviceForm = reactive({
  device_id: ''
})

const customNodeForm = reactive({
  label: '',
  node_type: 'network' as TopologyNode['node_type']
})

const linkForm = reactive({
  source_node_id: '',
  target_node_id: '',
  label: '',
  status: 'unknown' as TopologyLink['status']
})

const nodeOptions = computed(() => topology.value?.nodes ?? [])
const linkCount = computed(() => topology.value?.links.length ?? 0)
const availableDevices = computed(() => {
  const used = new Set((topology.value?.nodes ?? []).map((node) => node.device_id).filter(Boolean))
  return devices.value.filter((device) => !used.has(device.id))
})
const selectedBackendId = computed(() => (selectedCell.value ? getBackendId(selectedCell.value) : ''))
const selectedNode = computed(() => {
  if (!selectedCell.value?.isNode()) return null
  return nodeOptions.value.find((node) => node.id === selectedBackendId.value) ?? null
})
const selectedLink = computed(() => {
  if (!selectedCell.value?.isEdge()) return null
  return (topology.value?.links ?? []).find((link) => link.id === selectedBackendId.value) ?? null
})

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [topologyResult, deviceResult, neighborResult] = await Promise.all([
      getDefaultTopology(),
      listDevices(),
      listTopologyNeighbors({ unmatched: 1 })
    ])
    topology.value = topologyResult
    devices.value = deviceResult
    unmatchedNeighbors.value = neighborResult
    renderGraph()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载拓扑失败')
  } finally {
    loading.value = false
  }
}

function initGraph(): void {
  if (!graphContainer.value) return

  graph = new Graph({
    container: graphContainer.value,
    autoResize: true,
    grid: {
      visible: true,
      size: 16
    },
    background: {
      color: '#f8fafc'
    },
    panning: true,
    mousewheel: {
      enabled: true,
      modifiers: ['ctrl', 'meta'],
      minScale: 0.4,
      maxScale: 1.8
    },
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowNode: false,
      highlight: true,
      snap: true,
      router: {
        name: 'orth'
      },
      connector: {
        name: 'rounded',
        args: {
          radius: 8
        }
      },
      createEdge() {
        return graph!.createEdge({
          shape: 'edge',
          attrs: {
            line: {
              stroke: '#64748b',
              strokeWidth: 2,
              targetMarker: {
                name: 'classic',
                size: 7
              }
            }
          },
          zIndex: 0
        })
      }
    }
  })

  graph.on('cell:click', ({ cell }) => {
    selectedCell.value = cell
  })
  graph.on('blank:click', () => {
    selectedCell.value = null
  })
  graph.on('edge:connected', ({ edge }) => {
    void persistDrawnEdge(edge)
  })
}

function renderGraph(): void {
  if (!graph || !topology.value) return

  selectedCell.value = null
  graph.clearCells()
  topology.value.nodes.forEach((node) => {
    graph!.addNode({
      id: `node-${node.id}`,
      shape: 'rect',
      x: Number(node.x),
      y: Number(node.y),
      width: Number(node.width),
      height: Number(node.height),
      label: node.label,
      data: {
        backendId: node.id
      },
      attrs: {
        body: {
          rx: 8,
          ry: 8,
          fill: node.node_type === 'device' ? '#eff6ff' : '#f8fafc',
          stroke: node.device_enabled === false ? '#94a3b8' : '#2563eb',
          strokeWidth: 1.8
        },
        label: {
          fill: '#0f172a',
          fontSize: 13,
          fontWeight: 700,
          textWrap: {
            width: -16,
            height: -10,
            ellipsis: true
          }
        }
      },
      ports: buildNodePorts()
    })
  })

  topology.value.links.forEach((link) => {
    graph!.addEdge({
      id: `link-${link.id}`,
      shape: 'edge',
      source: `node-${link.source_node_id}`,
      target: `node-${link.target_node_id}`,
      labels: link.label ? [link.label] : [],
      data: {
        backendId: link.id
      },
      attrs: {
        line: {
          stroke: edgeColor(link.status),
          strokeWidth: 2,
          strokeDasharray: edgeDash(link)?.join(' '),
          targetMarker: {
            name: 'classic',
            size: 7
          }
        }
      },
      router: {
        name: 'orth'
      },
      connector: {
        name: 'rounded',
        args: {
          radius: 8
        }
      },
      zIndex: 0
    })
  })
}

function buildNodePorts() {
  const attrs = {
    circle: {
      r: 4,
      magnet: true,
      stroke: '#2563eb',
      strokeWidth: 1,
      fill: '#fff'
    }
  }
  return {
    groups: {
      top: { position: 'top', attrs },
      right: { position: 'right', attrs },
      bottom: { position: 'bottom', attrs },
      left: { position: 'left', attrs }
    },
    items: [
      { id: 'top', group: 'top' },
      { id: 'right', group: 'right' },
      { id: 'bottom', group: 'bottom' },
      { id: 'left', group: 'left' }
    ]
  }
}

function edgeColor(status: TopologyLink['status']): string {
  if (status === 'up') return '#16a34a'
  if (status === 'down') return '#dc2626'
  return '#64748b'
}

function edgeDash(link: TopologyLink): number[] | undefined {
  if (link.status === 'down') return [6, 4]
  if (link.auto_discovered) return undefined
  return [4, 4]
}

function neighborLocalLabel(neighbor: DeviceNeighbor): string {
  return neighbor.local_interface_name || neighbor.local_port_descr || neighbor.local_port_id || `ifIndex ${neighbor.local_if_index ?? '-'}`
}

function neighborRemoteLabel(neighbor: DeviceNeighbor): string {
  return neighbor.remote_device_name_matched || neighbor.remote_device_name || neighbor.remote_sys_name || neighbor.remote_chassis_id || '-'
}

function neighborProtocolLabel(neighbor: DeviceNeighbor): string {
  return neighbor.protocol.toUpperCase()
}

function nextNodePosition(): { x: number; y: number } {
  const count = topology.value?.nodes.length ?? 0
  return {
    x: 80 + (count % 4) * 220,
    y: 80 + Math.floor(count / 4) * 140
  }
}

async function addDeviceNode(): Promise<void> {
  const device = devices.value.find((item) => item.id === addDeviceForm.device_id)
  if (!device) {
    ElMessage.warning('请选择设备')
    return
  }

  await createTopologyNode({
    device_id: device.id,
    label: device.name,
    node_type: 'device',
    ...nextNodePosition()
  })
  addDeviceForm.device_id = ''
  ElMessage.success('设备节点已添加')
  await loadData()
}

async function runAutoSync(): Promise<void> {
  loading.value = true
  try {
    const result = await syncAutoTopology()
    topology.value = result.topology
    unmatchedNeighbors.value = await listTopologyNeighbors({ unmatched: 1 })
    renderGraph()
    ElMessage.success(`自动同步完成：新增 ${result.created_nodes} 个节点，更新 ${result.updated_links} 条链路`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '自动同步失败')
  } finally {
    loading.value = false
  }
}

async function addCustomNode(): Promise<void> {
  if (!customNodeForm.label.trim()) {
    ElMessage.warning('请输入节点名称')
    return
  }

  await createTopologyNode({
    label: customNodeForm.label.trim(),
    node_type: customNodeForm.node_type,
    ...nextNodePosition()
  })
  customNodeForm.label = ''
  ElMessage.success('节点已添加')
  await loadData()
}

async function createLink(): Promise<void> {
  if (!linkForm.source_node_id || !linkForm.target_node_id) {
    ElMessage.warning('请选择连线两端节点')
    return
  }
  if (linkForm.source_node_id === linkForm.target_node_id) {
    ElMessage.warning('连线两端不能是同一个节点')
    return
  }

  await createTopologyLink({
    source_node_id: linkForm.source_node_id,
    target_node_id: linkForm.target_node_id,
    label: linkForm.label,
    status: linkForm.status,
    link_type: 'manual'
  })
  linkForm.label = ''
  ElMessage.success('连线已添加')
  await loadData()
}

async function persistDrawnEdge(edge: Edge): Promise<void> {
  if (edge.getData()?.backendId) return

  const sourceNodeId = edge.getSourceCellId()?.replace('node-', '')
  const targetNodeId = edge.getTargetCellId()?.replace('node-', '')
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    graph?.removeCell(edge)
    return
  }

  try {
    await createTopologyLink({
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      status: 'unknown',
      link_type: 'manual'
    })
    ElMessage.success('连线已保存')
    await loadData()
  } catch (error) {
    graph?.removeCell(edge)
    ElMessage.error(error instanceof Error ? error.message : '保存连线失败')
  }
}

async function saveLayout(): Promise<void> {
  if (!graph) return

  saving.value = true
  try {
    const nodes = graph.getNodes().map((node) => {
      const position = node.position()
      const size = node.size()
      return {
        id: getBackendId(node),
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: Math.round(size.width),
        height: Math.round(size.height)
      }
    })
    topology.value = await saveTopologyLayout(nodes)
    renderGraph()
    ElMessage.success('拓扑布局已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存布局失败')
  } finally {
    saving.value = false
  }
}

async function removeSelected(): Promise<void> {
  const cell = selectedCell.value
  if (!cell) {
    ElMessage.warning('请先选择节点或连线')
    return
  }

  const id = getBackendId(cell)
  if (!id) return

  await ElMessageBox.confirm('确认删除当前选中的拓扑元素吗？', '删除拓扑元素', {
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
    type: 'warning',
    confirmButtonClass: 'el-button--danger'
  })

  if (cell.isNode()) {
    await deleteTopologyNode(id)
  } else {
    await deleteTopologyLink(id)
  }
  selectedCell.value = null
  ElMessage.success('已删除')
  await loadData()
}

function fitView(): void {
  graph?.zoomToFit({ padding: 40, maxScale: 1 })
}

async function toggleTopologyMaximized(): Promise<void> {
  isTopologyMaximized.value = !isTopologyMaximized.value
  await nextTick()
  graph?.resize()
  fitView()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isTopologyMaximized.value) {
    void toggleTopologyMaximized()
  }
}

function getBackendId(cell: Cell): string {
  const dataId = cell.getData()?.backendId
  if (dataId) return String(dataId)
  return cell.id.replace(/^node-/, '').replace(/^link-/, '')
}

onMounted(async () => {
  await nextTick()
  initGraph()
  await loadData()
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  graph?.dispose()
  graph = null
})
</script>

<template>
  <div v-loading="loading" class="topology-page" :class="{ 'is-focus-mode': isTopologyMaximized }">
    <div v-if="!isTopologyMaximized" class="page-toolbar">
      <div>
        <h2 class="page-title">网络拓扑</h2>
        <p class="page-subtitle">从 LLDP/CDP 邻居自动生成节点和链路，也支持手工补充布局</p>
      </div>
      <div class="topology-toolbar">
        <el-button type="success" :loading="loading" @click="runAutoSync">自动同步拓扑</el-button>
        <el-button @click="fitView">适配视图</el-button>
        <el-button type="primary" :loading="saving" @click="saveLayout">保存布局</el-button>
        <el-button type="danger" plain @click="removeSelected">删除选中</el-button>
        <el-button :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <div class="topology-layout">
      <el-card v-if="!isTopologyMaximized" class="page-card topology-panel" shadow="never">
        <template #header>拓扑元素</template>

        <div class="topology-section">
          <div class="topology-section__title">添加设备</div>
          <el-select v-model="addDeviceForm.device_id" placeholder="选择未加入拓扑的设备" filterable clearable>
            <el-option
              v-for="device in availableDevices"
              :key="device.id"
              :label="`${device.name} (${device.host})`"
              :value="device.id"
            />
          </el-select>
          <el-button type="primary" :disabled="!addDeviceForm.device_id" @click="addDeviceNode">添加设备节点</el-button>
        </div>

        <div class="topology-section">
          <div class="topology-section__title">添加自定义节点</div>
          <el-input v-model="customNodeForm.label" placeholder="例如 Internet、机房、汇聚区" />
          <el-select v-model="customNodeForm.node_type">
            <el-option label="网络区域" value="network" />
            <el-option label="自定义" value="custom" />
          </el-select>
          <el-button type="success" @click="addCustomNode">添加节点</el-button>
        </div>

        <div class="topology-section">
          <div class="topology-section__title">添加连线</div>
          <el-select v-model="linkForm.source_node_id" placeholder="源节点" filterable clearable>
            <el-option v-for="node in nodeOptions" :key="node.id" :label="node.label" :value="node.id" />
          </el-select>
          <el-select v-model="linkForm.target_node_id" placeholder="目标节点" filterable clearable>
            <el-option v-for="node in nodeOptions" :key="node.id" :label="node.label" :value="node.id" />
          </el-select>
          <el-input v-model="linkForm.label" placeholder="链路标签，可选" />
          <el-select v-model="linkForm.status">
            <el-option label="未知" value="unknown" />
            <el-option label="正常" value="up" />
            <el-option label="故障" value="down" />
          </el-select>
          <el-button type="primary" @click="createLink">添加连线</el-button>
        </div>

        <div class="topology-section topology-selected">
          <div class="topology-section__title">当前选择</div>
          <template v-if="selectedNode">
            <div class="topology-selected__name">{{ selectedNode.label }}</div>
            <div class="topology-selected__meta">节点类型：{{ selectedNode.node_type }}</div>
            <div v-if="selectedNode.device_host" class="topology-selected__meta">地址：{{ selectedNode.device_host }}</div>
            <div v-if="selectedNode.group_name" class="topology-selected__meta">分组：{{ selectedNode.group_name }}</div>
          </template>
          <template v-else-if="selectedLink">
            <div class="topology-selected__name">{{ selectedLink.label || '未命名链路' }}</div>
            <div class="topology-selected__meta">状态：{{ selectedLink.status }}</div>
            <div class="topology-selected__meta">类型：{{ selectedLink.link_type }}</div>
            <div v-if="selectedLink.discovery_protocol" class="topology-selected__meta">
              协议：{{ selectedLink.discovery_protocol.toUpperCase() }}
            </div>
            <div v-if="selectedLink.source_interface_name || selectedLink.target_interface_name" class="topology-selected__meta">
              接口：{{ selectedLink.source_interface_name || '-' }} / {{ selectedLink.target_interface_name || '-' }}
            </div>
          </template>
          <el-empty v-else description="未选择元素" :image-size="64" />
        </div>

        <div class="topology-section topology-neighbors">
          <div class="topology-section__title">未匹配邻居（{{ unmatchedNeighbors.length }}）</div>
          <el-empty v-if="unmatchedNeighbors.length === 0" description="暂无未匹配邻居" :image-size="64" />
          <div v-else class="neighbor-list">
            <div v-for="neighbor in unmatchedNeighbors" :key="neighbor.id" class="neighbor-item">
              <div class="neighbor-item__title">{{ neighborRemoteLabel(neighbor) }}</div>
              <div class="neighbor-item__meta">本端：{{ neighborLocalLabel(neighbor) }}</div>
              <div class="neighbor-item__meta">协议：{{ neighborProtocolLabel(neighbor) }}</div>
              <div v-if="neighbor.remote_mgmt_address" class="neighbor-item__meta">管理地址：{{ neighbor.remote_mgmt_address }}</div>
              <div v-if="neighbor.remote_port_id" class="neighbor-item__meta">远端端口：{{ neighbor.remote_port_id }}</div>
            </div>
          </div>
        </div>
      </el-card>

      <el-card class="page-card topology-canvas-card" shadow="never">
        <template #header>
          <div class="card-header-row">
            <span>{{ topology?.map.name || '默认拓扑' }}</span>
            <div class="topology-canvas-actions">
              <el-button v-if="isTopologyMaximized" @click="fitView">适配视图</el-button>
              <el-button v-if="isTopologyMaximized" type="primary" :loading="saving" @click="saveLayout">保存布局</el-button>
              <el-button :icon="FullScreen" @click="toggleTopologyMaximized">
                {{ isTopologyMaximized ? '退出最大化' : '最大化' }}
              </el-button>
              <span>{{ nodeOptions.length }} 个节点 / {{ linkCount }} 条链路</span>
            </div>
          </div>
        </template>
        <div ref="graphContainer" class="topology-canvas"></div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.topology-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.topology-layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  min-height: calc(100vh - 150px);
}

.topology-page.is-focus-mode .topology-layout {
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  min-height: calc(100vh - 104px);
}

.topology-panel :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.topology-section {
  display: grid;
  gap: 10px;
}

.topology-section__title {
  color: #0f172a;
  font-size: 14px;
  font-weight: 800;
}

.topology-selected {
  padding-top: 14px;
  border-top: 1px solid #e5e7eb;
}

.topology-neighbors {
  padding-top: 14px;
  border-top: 1px solid #e5e7eb;
}

.neighbor-list {
  display: grid;
  gap: 10px;
  max-height: 260px;
  overflow: auto;
}

.neighbor-item {
  padding: 10px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f8fafc;
}

.neighbor-item__title {
  color: #0f172a;
  font-size: 13px;
  font-weight: 800;
}

.neighbor-item__meta {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
}

.topology-selected__name {
  color: #0f172a;
  font-weight: 800;
}

.topology-selected__meta {
  color: #64748b;
  font-size: 13px;
}

.topology-canvas-card :deep(.el-card__body) {
  padding: 0;
}

.topology-canvas-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #0f172a;
  font-weight: 600;
}

.topology-canvas {
  width: 100%;
  height: calc(100vh - 218px);
  min-height: 620px;
  overflow: hidden;
}

.topology-page.is-focus-mode .topology-canvas-card {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 104px);
}

.topology-page.is-focus-mode .topology-canvas-card :deep(.el-card__header) {
  flex: 0 0 auto;
}

.topology-page.is-focus-mode .topology-canvas-card :deep(.el-card__body) {
  flex: 1 1 auto;
  min-height: 0;
}

.topology-page.is-focus-mode .topology-canvas {
  height: calc(100vh - 170px);
  min-height: 0;
}

@media (max-width: 1080px) {
  .topology-layout {
    grid-template-columns: 1fr;
  }

  .topology-canvas {
    height: 620px;
  }
}
</style>
