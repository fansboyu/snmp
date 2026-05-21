<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
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
  updateDeviceGroup,
  updateTemplateDefinition,
  type DeviceGroup,
  type DeviceInterface,
  type InterfaceMetricSample,
  type MetricDefinition,
  type OidTemplate
} from '../services/api'

const loading = ref(false)
const updatingGroupId = ref('')
const updatingBindingKey = ref('')
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
  vendor: '',
  device_type: 'switch',
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
    if (!activeTemplateId.value) {
      activeTemplateId.value = defaultTemplateId(templateResult)
    }
    if (!groupForm.template_id || !templateResult.some((template) => template.id === groupForm.template_id)) {
      groupForm.template_id = defaultTemplateId(templateResult)
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
  templateForm.vendor = ''
  templateForm.device_type = 'switch'
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
  groupForm.template_id = defaultTemplateId(templates.value)
  await loadData()
}

async function changeGroupTemplate(group: DeviceGroup, templateId: string | null): Promise<void> {
  const targetTemplateName = templateId ? templates.value.find((template) => template.id === templateId)?.name || '所选模板' : '未绑定'
  try {
    await ElMessageBox.confirm(
      `确认将分组「${group.name}」的绑定模板修改为「${targetTemplateName}」吗？该分组下设备后续会按新模板采集。`,
      '修改绑定模板',
      {
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    groups.value = await listDeviceGroups()
    return
  }

  updatingGroupId.value = group.id
  try {
    await updateDeviceGroup(group.id, { template_id: templateId || null })
    ElMessage.success('分组模板已更新')
    groups.value = await listDeviceGroups()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新分组模板失败')
    groups.value = await listDeviceGroups()
  } finally {
    updatingGroupId.value = ''
  }
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

async function changeTemplateDefinitionFlag(definition: MetricDefinition, bindingEnabled: boolean): Promise<void> {
  if (!activeTemplateId.value) {
    return
  }
  updatingBindingKey.value = `${activeTemplateId.value}:${definition.id}`
  try {
    await updateTemplateDefinition(activeTemplateId.value, definition.id, { binding_enabled: bindingEnabled })
    ElMessage.success('模板指标已更新')
    await loadTemplateDefinitions()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新模板指标失败')
    await loadTemplateDefinitions()
  } finally {
    updatingBindingKey.value = ''
  }
}

async function selectTemplate(row?: OidTemplate): Promise<void> {
  activeTemplateId.value = row?.id || ''
  await loadTemplateDefinitions()
}

function defaultTemplateId(items: OidTemplate[]): string {
  return items.find((template) => template.name === '默认 SNMP 模板')?.id || items[0]?.id || ''
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
            <el-form-item label="厂商">
              <el-input v-model="templateForm.vendor" placeholder="例如 huawei" />
            </el-form-item>
            <el-form-item label="设备类型">
              <el-select v-model="templateForm.device_type" class="form-template-select" placeholder="选择设备类型">
                <el-option label="交换机" value="switch" />
                <el-option label="路由器" value="router" />
                <el-option label="防火墙" value="firewall" />
                <el-option label="通用设备" value="generic" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="success" native-type="submit">创建模板</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="templates" row-key="id" height="260" @current-change="selectTemplate">
            <el-table-column prop="name" label="模板名称" min-width="180" />
            <el-table-column prop="vendor" label="厂商" width="100" />
            <el-table-column prop="device_type" label="设备类型" width="110" />
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
          <el-form class="compact-form group-form" :model="groupForm" inline @submit.prevent="submitGroup">
            <el-form-item label="名称">
              <el-input v-model="groupForm.name" placeholder="例如 核心网络" />
            </el-form-item>
            <el-form-item label="绑定模板">
              <el-select v-model="groupForm.template_id" class="form-template-select" placeholder="选择绑定模板" clearable>
                <el-option v-for="template in templates" :key="template.id" :label="template.name" :value="template.id" />
              </el-select>
            </el-form-item>
            <el-form-item class="group-form__actions">
              <el-button type="success" native-type="submit">创建分组</el-button>
            </el-form-item>
          </el-form>

          <el-table :data="groups" row-key="id" height="260">
            <el-table-column prop="name" label="分组名称" min-width="160" />
            <el-table-column prop="template_name" label="绑定模板" min-width="220">
              <template #default="{ row }">
                <el-select
                  :model-value="row.template_id || ''"
                  placeholder="未绑定"
                  clearable
                  filterable
                  size="small"
                  :loading="updatingGroupId === row.id"
                  @change="(value: string) => changeGroupTemplate(row, value || null)"
                >
                  <el-option v-for="template in templates" :key="template.id" :label="template.name" :value="template.id" />
                </el-select>
              </template>
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
          <el-option
            v-for="definition in definitions"
            :key="definition.id"
            :label="`${definition.name} (${definition.metric_kind}${definition.aggregate_method ? `/${definition.aggregate_method}` : ''})`"
            :value="definition.id"
          />
        </el-select>
        <el-button type="primary" @click="attachDefinition">加入模板</el-button>
      </div>
      <el-table :data="templateDefinitions" row-key="id" empty-text="请选择模板或添加指标">
        <el-table-column label="指标名称" min-width="190">
          <template #default="{ row }">
            <div class="metric-name">{{ row.display_name || row.name }}</div>
            <div class="metric-code">{{ row.name }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="oid" label="OID" min-width="260" show-overflow-tooltip />
        <el-table-column prop="metric_kind" label="类型" width="120" />
        <el-table-column prop="value_type" label="值类型" width="110" />
        <el-table-column prop="scale" label="倍率" width="90" />
        <el-table-column prop="precision" label="精度" width="80" />
        <el-table-column prop="aggregate_method" label="聚合" width="100" />
        <el-table-column prop="display_group" label="分组" width="100" />
        <el-table-column prop="vendor" label="厂商" width="100" />
        <el-table-column prop="unit" label="单位" width="100" />
        <el-table-column label="图表" width="80">
          <template #default="{ row }">
            <el-tag :type="row.chartable ? 'success' : 'info'">{{ row.chartable ? '是' : '否' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="告警" width="80">
          <template #default="{ row }">
            <el-tag :type="row.alertable ? 'warning' : 'info'">{{ row.alertable ? '是' : '否' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="采集" width="90" fixed="right">
          <template #default="{ row }">
            <el-switch
              :model-value="row.binding_enabled"
              :loading="updatingBindingKey === `${activeTemplateId}:${row.id}`"
              @change="(value: boolean) => changeTemplateDefinitionFlag(row, value)"
            />
          </template>
        </el-table-column>
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

<style scoped>
.form-template-select {
  width: 190px;
}

.metric-name {
  font-weight: 600;
  color: #1f2d3d;
}

.metric-code {
  margin-top: 2px;
  font-size: 12px;
  color: #8a97a8;
}
</style>
