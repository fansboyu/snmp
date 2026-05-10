<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import MetricCard from '../components/MetricCard.vue'
import {
  createAlertRule,
  getAlertSummary,
  listAlertEvents,
  listAlertNotifications,
  listAlertRules,
  retryAlertNotification,
  resolveAlertEvent,
  updateAlertRule,
  type AlertEvent,
  type AlertNotification,
  type AlertRule,
  type AlertSummary
} from '../services/api'

const loading = ref(false)
const summary = ref<AlertSummary | null>(null)
const events = ref<AlertEvent[]>([])
const rules = ref<AlertRule[]>([])
const notifications = ref<AlertNotification[]>([])
const eventStatus = ref<'active' | 'resolved' | ''>('active')
const notificationStatus = ref<'pending' | 'sending' | 'sent' | 'failed' | ''>('')
const resolvingId = ref('')
const retryingNotificationId = ref('')
const ruleForm = reactive({
  name: '',
  rule_type: 'cpu_threshold',
  severity: 'warning' as AlertRule['severity'],
  metric_name: 'cpuUsage',
  operator: '>',
  threshold: 80,
  enabled: true
})

const activeEvents = computed(() => events.value.filter((event) => event.status === 'active'))

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [summaryResult, eventResult, ruleResult, notificationResult] = await Promise.all([
      getAlertSummary(),
      listAlertEvents({ status: eventStatus.value || '', limit: 200 }),
      listAlertRules(),
      listAlertNotifications({ status: notificationStatus.value || '', limit: 100 })
    ])
    summary.value = summaryResult
    events.value = eventResult
    rules.value = ruleResult
    notifications.value = notificationResult
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载告警中心失败')
  } finally {
    loading.value = false
  }
}

async function submitRule(): Promise<void> {
  if (!ruleForm.name) {
    ElMessage.warning('请输入规则名称')
    return
  }
  await createAlertRule({ ...ruleForm })
  ElMessage.success('告警规则已创建')
  ruleForm.name = ''
  await loadData()
}

async function toggleRule(rule: AlertRule): Promise<void> {
  await updateAlertRule(rule.id, { enabled: !rule.enabled })
  ElMessage.success(rule.enabled ? '规则已停用' : '规则已启用')
  await loadData()
}

async function resolveEvent(event: AlertEvent): Promise<void> {
  resolvingId.value = event.id
  try {
    await resolveAlertEvent(event.id)
    ElMessage.success('告警已恢复')
    await loadData()
  } finally {
    resolvingId.value = ''
  }
}

async function retryNotification(notification: AlertNotification): Promise<void> {
  retryingNotificationId.value = notification.id
  try {
    await retryAlertNotification(notification.id)
    ElMessage.success('通知已重新入队')
    await loadData()
  } finally {
    retryingNotificationId.value = ''
  }
}

function severityType(severity: AlertEvent['severity']): 'danger' | 'warning' | 'info' {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function statusType(status: AlertEvent['status']): 'danger' | 'success' {
  return status === 'active' ? 'danger' : 'success'
}

function notificationStatusType(status: AlertNotification['status']): 'info' | 'warning' | 'success' | 'danger' {
  if (status === 'sent') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'sending') return 'warning'
  return 'info'
}

function ruleTypeName(type: string): string {
  const names: Record<string, string> = {
    cpu_threshold: 'CPU 阈值',
    interface_down: '接口 Down',
    device_no_data: '设备无数据'
  }
  return names[type] || type
}

onMounted(loadData)
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <h2 class="page-title">告警中心</h2>
      <div class="toolbar-actions">
        <el-select v-model="eventStatus" placeholder="事件状态" @change="loadData">
          <el-option label="当前告警" value="active" />
          <el-option label="历史恢复" value="resolved" />
          <el-option label="全部事件" value="" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :span="6">
        <MetricCard title="当前告警" :value="summary?.active_count || 0" description="未恢复事件" type="danger" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="严重告警" :value="summary?.critical_count || 0" description="critical 级别" type="danger" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="警告告警" :value="summary?.warning_count || 0" description="warning 级别" type="warning" />
      </el-col>
      <el-col :span="6">
        <MetricCard title="已恢复" :value="summary?.resolved_count || 0" description="历史恢复事件" type="success" />
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>当前 / 历史告警事件</template>
      <el-table :data="events" row-key="id" empty-text="暂无告警事件">
        <el-table-column label="级别" width="100">
          <template #default="{ row }">
            <el-tag :type="severityType(row.severity)">{{ row.severity }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ row.status === 'active' ? '告警中' : '已恢复' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="160" />
        <el-table-column prop="device_name" label="设备" min-width="150" />
        <el-table-column prop="interface_name" label="接口" min-width="140">
          <template #default="{ row }">{{ row.interface_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="message" label="详情" min-width="260" show-overflow-tooltip />
        <el-table-column prop="last_seen_at" label="最近触发" width="220" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'active'"
              type="success"
              link
              :loading="resolvingId === row.id"
              @click="resolveEvent(row)"
            >
              标记恢复
            </el-button>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="alert-empty-hint" v-if="activeEvents.length === 0 && eventStatus === 'active'">当前没有未恢复告警</div>
    </el-card>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>
        <div class="card-header-row">
          <span>邮件通知记录</span>
          <el-select v-model="notificationStatus" placeholder="通知状态" clearable @change="loadData">
            <el-option label="全部" value="" />
            <el-option label="待发送" value="pending" />
            <el-option label="发送中" value="sending" />
            <el-option label="已发送" value="sent" />
            <el-option label="失败" value="failed" />
          </el-select>
        </div>
      </template>
      <el-table :data="notifications" row-key="id" empty-text="暂无通知记录">
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="notificationStatusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="channel" label="通道" width="90" />
        <el-table-column prop="target" label="收件人" min-width="180" show-overflow-tooltip />
        <el-table-column prop="subject" label="标题" min-width="260" show-overflow-tooltip />
        <el-table-column prop="device_name" label="设备" min-width="140" />
        <el-table-column prop="retry_count" label="重试" width="80" />
        <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.error || '-' }}</template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="220" />
        <el-table-column prop="sent_at" label="发送时间" width="220">
          <template #default="{ row }">{{ row.sent_at || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'failed'"
              link
              type="primary"
              :loading="retryingNotificationId === row.id"
              @click="retryNotification(row)"
            >
              重试
            </el-button>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="10">
        <el-card class="page-card" shadow="never">
          <template #header>新增告警规则</template>
          <el-form :model="ruleForm" label-width="96px" @submit.prevent="submitRule">
            <el-form-item label="规则名称">
              <el-input v-model="ruleForm.name" placeholder="例如 CPU 超过 90%" />
            </el-form-item>
            <el-form-item label="规则类型">
              <el-select v-model="ruleForm.rule_type">
                <el-option label="CPU 阈值" value="cpu_threshold" />
                <el-option label="接口 Down" value="interface_down" />
              </el-select>
            </el-form-item>
            <el-form-item label="级别">
              <el-select v-model="ruleForm.severity">
                <el-option label="warning" value="warning" />
                <el-option label="critical" value="critical" />
              </el-select>
            </el-form-item>
            <el-form-item label="指标名">
              <el-input v-model="ruleForm.metric_name" placeholder="cpuUsage / ifOperStatus" />
            </el-form-item>
            <el-form-item label="条件">
              <div class="rule-condition">
                <el-select v-model="ruleForm.operator">
                  <el-option label=">" value=">" />
                  <el-option label=">=" value=">=" />
                  <el-option label="=" value="=" />
                  <el-option label="<=" value="<=" />
                  <el-option label="<" value="<" />
                </el-select>
                <el-input-number v-model="ruleForm.threshold" :min="0" :max="1000000" />
              </div>
            </el-form-item>
            <el-form-item label="启用">
              <el-switch v-model="ruleForm.enabled" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" native-type="submit">创建规则</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card class="page-card" shadow="never">
          <template #header>告警规则</template>
          <el-table :data="rules" row-key="id" empty-text="暂无规则">
            <el-table-column prop="name" label="规则名称" min-width="180" show-overflow-tooltip />
            <el-table-column label="类型" width="120">
              <template #default="{ row }">{{ ruleTypeName(row.rule_type) }}</template>
            </el-table-column>
            <el-table-column prop="severity" label="级别" width="100" />
            <el-table-column label="条件" min-width="140">
              <template #default="{ row }">{{ row.metric_name || '-' }} {{ row.operator || '' }} {{ row.threshold || '' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" @click="toggleRule(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
