<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  cancelDiscoveryJob,
  createDiscoveryJob,
  importDiscoveryResults,
  listDeviceGroups,
  listDiscoveryJobs,
  listDiscoveryResults,
  type DeviceGroup,
  type DiscoveryJob,
  type DiscoveryResult
} from '../services/api'

const loading = ref(false)
const importing = ref(false)
const selectedJobId = ref('')
const jobs = ref<DiscoveryJob[]>([])
const results = ref<DiscoveryResult[]>([])
const groups = ref<DeviceGroup[]>([])
const selectedResults = ref<DiscoveryResult[]>([])
let refreshTimer: number | undefined

const form = reactive({
  cidr: '172.28.0.0/28',
  port: 161,
  community: 'public',
  timeout_ms: 1000,
  retries: 0,
  concurrency: 16
})

const importForm = reactive({
  group_id: '',
  enabled: false
})

const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value) ?? null)
const progressPercent = computed(() => {
  const job = selectedJob.value
  if (!job || job.total_hosts === 0) return 0
  return Math.min(100, Math.round((job.scanned_hosts / job.total_hosts) * 100))
})
const importableResults = computed(() => results.value.filter((result) => !result.device_id))

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [jobResult, groupResult] = await Promise.all([
      listDiscoveryJobs({ limit: 50 }),
      listDeviceGroups()
    ])
    jobs.value = jobResult
    groups.value = groupResult
    if (!selectedJobId.value && jobResult[0]) {
      selectedJobId.value = jobResult[0].id
    }
    await loadResults()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载自动发现数据失败')
  } finally {
    loading.value = false
  }
}

async function loadResults(): Promise<void> {
  if (!selectedJobId.value) {
    results.value = []
    selectedResults.value = []
    return
  }
  results.value = await listDiscoveryResults(selectedJobId.value, { limit: 500 })
  selectedResults.value = []
}

async function submitJob(): Promise<void> {
  if (!form.cidr || !form.community) {
    ElMessage.warning('请输入 CIDR 和 community')
    return
  }
  const job = await createDiscoveryJob({ ...form })
  ElMessage.success('发现任务已创建')
  selectedJobId.value = job.id
  await loadData()
}

async function cancelJob(job: DiscoveryJob): Promise<void> {
  await cancelDiscoveryJob(job.id)
  ElMessage.success('任务已取消')
  await loadData()
}

async function importSelected(): Promise<void> {
  const resultIds = selectedResults.value
    .filter((result) => !result.device_id)
    .map((result) => result.id)
  if (resultIds.length === 0) {
    ElMessage.warning('请选择未导入的发现结果')
    return
  }

  importing.value = true
  try {
    const response = await importDiscoveryResults({
      resultIds,
      group_id: importForm.group_id || null,
      enabled: importForm.enabled
    })
    ElMessage.success(`导入 ${response.imported.length} 台，跳过 ${response.skipped.length} 条`)
    await loadData()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    importing.value = false
  }
}

function handleSelectionChange(selection: DiscoveryResult[]): void {
  selectedResults.value = selection
}

async function selectJob(row?: DiscoveryJob): Promise<void> {
  selectedJobId.value = row?.id || ''
  await loadResults()
}

function canSelectResult(row: DiscoveryResult): boolean {
  return !row.device_id
}

function statusType(status: DiscoveryJob['status']): 'info' | 'warning' | 'success' | 'danger' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'warning'
  return 'info'
}

function canCancel(job: DiscoveryJob): boolean {
  return job.status === 'pending' || job.status === 'running'
}

onMounted(() => {
  void loadData()
  refreshTimer = window.setInterval(() => {
    const hasRunningJob = jobs.value.some((job) => job.status === 'pending' || job.status === 'running')
    if (hasRunningJob) void loadData()
  }, 3000)
})

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <div>
        <h2 class="page-title">自动发现</h2>
        <p class="page-subtitle">SNMP v2c CIDR 扫描，发现结果确认后再导入设备</p>
      </div>
      <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
    </div>

    <el-card class="page-card" shadow="never">
      <template #header>创建发现任务</template>
      <el-form class="discovery-form" :model="form" label-width="96px" @submit.prevent="submitJob">
        <el-form-item label="CIDR">
          <el-input v-model="form.cidr" placeholder="172.28.0.0/28" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="form.port" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="Community">
          <el-input v-model="form.community" show-password />
        </el-form-item>
        <el-form-item label="超时(ms)">
          <el-input-number v-model="form.timeout_ms" :min="500" :max="5000" :step="100" />
        </el-form-item>
        <el-form-item label="重试">
          <el-input-number v-model="form.retries" :min="0" :max="2" />
        </el-form-item>
        <el-form-item label="并发">
          <el-input-number v-model="form.concurrency" :min="1" :max="64" />
        </el-form-item>
        <el-form-item>
          <el-button type="success" native-type="submit">开始发现</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="10">
        <el-card class="page-card" shadow="never">
          <template #header>发现任务</template>
          <el-table :data="jobs" row-key="id" height="360" highlight-current-row @current-change="selectJob">
            <el-table-column prop="id" label="ID" width="72" />
            <el-table-column prop="cidr" label="CIDR" min-width="130" />
            <el-table-column label="状态" width="105">
              <template #default="{ row }">
                <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" min-width="150">
              <template #default="{ row }">
                <span>{{ row.scanned_hosts }} / {{ row.total_hosts }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="discovered_hosts" label="发现" width="76" />
            <el-table-column label="操作" width="86" fixed="right">
              <template #default="{ row }">
                <el-button v-if="canCancel(row)" link type="danger" @click.stop="cancelJob(row)">取消</el-button>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card class="page-card" shadow="never">
          <template #header>
            <div class="card-header-row">
              <span>任务进度</span>
              <span v-if="selectedJob">{{ selectedJob.cidr }}</span>
            </div>
          </template>
          <el-empty v-if="!selectedJob" description="暂无发现任务" />
          <template v-else>
            <el-progress :percentage="progressPercent" :status="selectedJob.status === 'failed' ? 'exception' : selectedJob.status === 'completed' ? 'success' : undefined" />
            <div class="discovery-stats">
              <span>总数：{{ selectedJob.total_hosts }}</span>
              <span>已扫描：{{ selectedJob.scanned_hosts }}</span>
              <span>已发现：{{ selectedJob.discovered_hosts }}</span>
              <span>状态：{{ selectedJob.status }}</span>
            </div>
            <el-alert v-if="selectedJob.error_message" class="dashboard-row" type="error" :title="selectedJob.error_message" :closable="false" />
          </template>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>
        <div class="card-header-row">
          <span>发现结果</span>
          <div class="discovery-import-actions">
            <el-select v-model="importForm.group_id" placeholder="导入分组" clearable>
              <el-option v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" />
            </el-select>
            <el-switch v-model="importForm.enabled" active-text="导入后启用" />
            <el-button type="primary" :disabled="selectedResults.length === 0" :loading="importing" @click="importSelected">
              导入选中
            </el-button>
          </div>
        </div>
      </template>
      <el-table :data="results" row-key="id" empty-text="暂无发现结果" @selection-change="handleSelectionChange">
        <el-table-column type="selection" width="48" :selectable="canSelectResult" />
        <el-table-column prop="host" label="地址" min-width="130" />
        <el-table-column prop="sys_name" label="sysName" min-width="160" show-overflow-tooltip />
        <el-table-column prop="sys_descr" label="sysDescr" min-width="260" show-overflow-tooltip />
        <el-table-column prop="sys_object_id" label="sysObjectID" min-width="160" show-overflow-tooltip />
        <el-table-column prop="response_ms" label="响应(ms)" width="100" />
        <el-table-column label="导入状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.device_id ? 'success' : 'info'">{{ row.device_id ? '已导入' : '未导入' }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div class="alert-empty-hint" v-if="importableResults.length === 0 && results.length > 0">当前任务结果已全部导入或关联到已有设备</div>
    </el-card>
  </div>
</template>
