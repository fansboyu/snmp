<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  addTemplateDefinition,
  createDeviceGroup,
  createOidTemplate,
  listDeviceGroups,
  listInterfaces,
  listInterfaceSamples,
  listMetricDefinitions,
  listOidTemplates,
  listTemplateDefinitions,
  type DeviceGroup,
  type DeviceInterface,
  type InterfaceMetricSample,
  type MetricDefinition,
  type OidTemplate
} from '../services/api'

const loading = ref(false)
const templates = ref<OidTemplate[]>([])
const groups = ref<DeviceGroup[]>([])
const definitions = ref<MetricDefinition[]>([])
const templateDefinitions = ref<MetricDefinition[]>([])
const interfaces = ref<DeviceInterface[]>([])
const interfaceSamples = ref<InterfaceMetricSample[]>([])
const activeTemplateId = ref('')

const templateForm = reactive({
  name: '',
  description: '',
  enabled: true
})

const groupForm = reactive({
  name: '',
  description: '',
  template_id: ''
})

const attachForm = reactive({
  metric_id: ''
})

const interfaceTitle = computed(() => `接口清单（${interfaces.value.length}）`)

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [templateResult, groupResult, definitionResult, interfaceResult, sampleResult] = await Promise.all([
      listOidTemplates(),
      listDeviceGroups(),
      listMetricDefinitions(),
      listInterfaces(),
      listInterfaceSamples({ limit: 100 })
    ])
    templates.value = templateResult
    groups.value = groupResult
    definitions.value = definitionResult
    interfaces.value = interfaceResult
    interfaceSamples.value = sampleResult
    if (!activeTemplateId.value && templateResult[0]) {
      activeTemplateId.value = templateResult[0].id
    }
    await loadTemplateDefinitions()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载指标管理数据失败')
  } finally {
    loading.value = false
  }
}

async function loadTemplateDefinitions(): Promise<void> {
  if (!activeTemplateId.value) {
    templateDefinitions.value = []
    return
  }
  templateDefinitions.value = await listTemplateDefinitions(activeTemplateId.value)
}

async function submitTemplate(): Promise<void> {
  if (!templateForm.name) {
    ElMessage.warning('请输入模板名称')
    return
  }
  await createOidTemplate({ ...templateForm })
  ElMessage.success('OID 模板已创建')
  templateForm.name = ''
  templateForm.description = ''
  await loadData()
}

async function submitGroup(): Promise<void> {
  if (!groupForm.name) {
    ElMessage.warning('请输入分组名称')
    return
  }
  await createDeviceGroup({ ...groupForm, template_id: groupForm.template_id || null })
  ElMessage.success('设备分组已创建')
  groupForm.name = ''
  groupForm.description = ''
  groupForm.template_id = ''
  await loadData()
}

async function attachDefinition(): Promise<void> {
  if (!activeTemplateId.value || !attachForm.metric_id) {
    ElMessage.warning('请选择模板和指标')
    return
  }
  await addTemplateDefinition(activeTemplateId.value, attachForm.metric_id, templateDefinitions.value.length * 10 + 10)
  ElMessage.success('指标已加入模板')
  attachForm.metric_id = ''
  await loadTemplateDefinitions()
  templates.value = await listOidTemplates()
}

async function selectTemplate(row?: OidTemplate): Promise<void> {
  activeTemplateId.value = row?.id || ''
  await loadTemplateDefinitions()
}

onMounted(loadData)
</script>

<template>
  <div v-loading="loading" class="metrics-page">
    <div class="page-toolbar">
      <h2 class="page-title">指标管理</h2>
      <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
    </div>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header>OID 模板</template>
          <el-form class="compact-form" :model="templateForm" inline @submit.prevent="submitTemplate">
            <el-form-item label="名称">
              <el-input v-model="templateForm.name" placeholder="例如 核心交换机模板" />
            </el-form-item>
            <el-form-item label="描述">
              <el-input v-model="templateForm.description" placeholder="可选" />
            </el-form-item>
            <el-form-item>
              <el-button type="success" native-type="submit">创建模板</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="templates" row-key="id" height="260" @current-change="selectTemplate">
            <el-table-column prop="name" label="模板名称" min-width="180" />
            <el-table-column prop="definition_count" label="指标数" width="90" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header>设备分组</template>
          <el-form class="compact-form" :model="groupForm" inline @submit.prevent="submitGroup">
            <el-form-item label="名称">
              <el-input v-model="groupForm.name" placeholder="例如 核心网络" />
            </el-form-item>
            <el-form-item label="模板">
              <el-select v-model="groupForm.template_id" placeholder="选择模板" clearable>
                <el-option v-for="template in templates" :key="template.id" :label="template.name" :value="template.id" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="success" native-type="submit">创建分组</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="groups" row-key="id" height="260">
            <el-table-column prop="name" label="分组名称" min-width="160" />
            <el-table-column prop="template_name" label="绑定模板" min-width="180">
              <template #default="{ row }">{{ row.template_name || '未绑定' }}</template>
            </el-table-column>
            <el-table-column prop="device_count" label="设备数" width="90" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="page-card dashboard-row" shadow="never">
      <template #header>模板指标</template>
      <div class="template-toolbar">
        <el-select v-model="activeTemplateId" placeholder="选择模板" @change="loadTemplateDefinitions">
          <el-option v-for="template in templates" :key="template.id" :label="template.name" :value="template.id" />
        </el-select>
        <el-select v-model="attachForm.metric_id" placeholder="选择指标加入模板" filterable>
          <el-option v-for="definition in definitions" :key="definition.id" :label="`${definition.name} (${definition.metric_kind})`" :value="definition.id" />
        </el-select>
        <el-button type="primary" @click="attachDefinition">加入模板</el-button>
      </div>
      <el-table :data="templateDefinitions" row-key="id" empty-text="请选择模板或添加指标">
        <el-table-column prop="name" label="指标名称" min-width="180" />
        <el-table-column prop="oid" label="OID" min-width="260" show-overflow-tooltip />
        <el-table-column prop="metric_kind" label="类型" width="120" />
        <el-table-column prop="unit" label="单位" width="100" />
      </el-table>
    </el-card>

    <el-row :gutter="16" class="dashboard-row">
      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header>{{ interfaceTitle }}</template>
          <el-table :data="interfaces" row-key="id" height="320" empty-text="暂无接口数据">
            <el-table-column prop="device_name" label="设备" min-width="150" />
            <el-table-column prop="if_index" label="ifIndex" width="90" />
            <el-table-column label="接口" min-width="160">
              <template #default="{ row }">{{ row.if_name || row.if_descr || '-' }}</template>
            </el-table-column>
            <el-table-column prop="oper_status" label="状态" width="100" />
            <el-table-column prop="last_seen_at" label="最近发现" min-width="180" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card class="page-card" shadow="never">
          <template #header>接口样本</template>
          <el-table :data="interfaceSamples" height="320" empty-text="暂无接口样本">
            <el-table-column prop="device_name" label="设备" min-width="140" />
            <el-table-column prop="interface_name" label="接口" min-width="140" />
            <el-table-column prop="metric_name" label="指标" min-width="130" />
            <el-table-column label="值" min-width="120">
              <template #default="{ row }">{{ row.value_text }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column prop="created_at" label="采集时间" min-width="180" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
