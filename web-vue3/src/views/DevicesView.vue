<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createDevice, deleteDevice, listDeviceGroups, listDevices, type Device, type DeviceGroup } from '../services/api'

const loading = ref(false)
const deletingId = ref('')
const keyword = ref('')
const devices = ref<Device[]>([])
const groups = ref<DeviceGroup[]>([])

const form = reactive({
  name: '',
  host: '',
  port: 161,
  group_id: '',
  community: 'public',
  snmp_version: '2c' as '2c' | '3',
  snmp_v3_username: '',
  snmp_v3_security_level: 'noAuthNoPriv' as 'noAuthNoPriv' | 'authNoPriv' | 'authPriv',
  snmp_v3_auth_protocol: 'SHA256',
  snmp_v3_auth_passphrase: '',
  snmp_v3_priv_protocol: 'AES',
  snmp_v3_priv_passphrase: '',
  snmp_v3_context_name: '',
  enabled: false
})

const filteredDevices = computed(() => {
  const normalized = keyword.value.trim().toLowerCase()
  if (!normalized) return devices.value
  return devices.value.filter((device) =>
    `${device.name} ${device.host} ${device.group_name || ''} ${device.snmp_version || ''}`.toLowerCase().includes(normalized)
  )
})

const needsAuth = computed(() => form.snmp_version === '3' && form.snmp_v3_security_level !== 'noAuthNoPriv')
const needsPrivacy = computed(() => form.snmp_version === '3' && form.snmp_v3_security_level === 'authPriv')

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [deviceResult, groupResult] = await Promise.all([listDevices(), listDeviceGroups()])
    devices.value = deviceResult
    groups.value = groupResult
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载设备失败')
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (!form.name || !form.host) {
    ElMessage.warning('请输入设备名称和地址')
    return
  }
  if (form.snmp_version === '3' && !form.snmp_v3_username) {
    ElMessage.warning('SNMP v3 需要填写用户名')
    return
  }
  if (needsAuth.value && !form.snmp_v3_auth_passphrase) {
    ElMessage.warning('当前安全级别需要认证密码')
    return
  }
  if (needsPrivacy.value && !form.snmp_v3_priv_passphrase) {
    ElMessage.warning('authPriv 安全级别需要加密密码')
    return
  }

  await createDevice({
    ...form,
    group_id: form.group_id || null,
    snmp_v3_username: form.snmp_version === '3' ? form.snmp_v3_username : null,
    snmp_v3_security_level: form.snmp_v3_security_level,
    snmp_v3_auth_protocol: needsAuth.value ? form.snmp_v3_auth_protocol : null,
    snmp_v3_auth_passphrase: needsAuth.value ? form.snmp_v3_auth_passphrase : null,
    snmp_v3_priv_protocol: needsPrivacy.value ? form.snmp_v3_priv_protocol : null,
    snmp_v3_priv_passphrase: needsPrivacy.value ? form.snmp_v3_priv_passphrase : null,
    snmp_v3_context_name: form.snmp_version === '3' ? form.snmp_v3_context_name || null : null
  })
  ElMessage.success('设备已添加')
  resetForm()
  await loadData()
}

function resetForm(): void {
  form.name = ''
  form.host = ''
  form.port = 161
  form.group_id = ''
  form.community = 'public'
  form.snmp_version = '2c'
  form.snmp_v3_username = ''
  form.snmp_v3_security_level = 'noAuthNoPriv'
  form.snmp_v3_auth_protocol = 'SHA256'
  form.snmp_v3_auth_passphrase = ''
  form.snmp_v3_priv_protocol = 'AES'
  form.snmp_v3_priv_passphrase = ''
  form.snmp_v3_context_name = ''
  form.enabled = false
}

async function removeDevice(device: Device): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除设备「${device.name}」吗？删除后该设备的采集样本、接口清单和告警事件也会一并删除。`,
    '删除设备',
    {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    }
  )

  deletingId.value = device.id
  try {
    await deleteDevice(device.id)
    ElMessage.success('设备已删除')
    await loadData()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除设备失败')
  } finally {
    deletingId.value = ''
  }
}

onMounted(loadData)
</script>

<template>
  <el-card class="page-card" shadow="never">
    <div class="page-toolbar">
      <h2 class="page-title">设备管理</h2>
      <div class="toolbar-actions">
        <el-input v-model="keyword" placeholder="搜索设备名称、IP、分组或 SNMP 版本" clearable />
        <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <el-form class="device-form" :model="form" label-width="96px" @submit.prevent="submit">
      <div class="form-grid">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如 Core Switch" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.host" placeholder="192.0.2.20" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="form.port" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="分组">
          <el-select v-model="form.group_id" placeholder="选择设备分组" clearable>
            <el-option v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="SNMP 版本">
          <el-select v-model="form.snmp_version">
            <el-option label="SNMP v2c" value="2c" />
            <el-option label="SNMP v3" value="3" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.snmp_version === '2c'" label="Community">
          <el-input v-model="form.community" />
        </el-form-item>
        <template v-else>
          <el-form-item label="用户名">
            <el-input v-model="form.snmp_v3_username" placeholder="SNMP v3 UserName" />
          </el-form-item>
          <el-form-item label="安全级别">
            <el-select v-model="form.snmp_v3_security_level">
              <el-option label="noAuthNoPriv" value="noAuthNoPriv" />
              <el-option label="authNoPriv" value="authNoPriv" />
              <el-option label="authPriv" value="authPriv" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="needsAuth" label="认证算法">
            <el-select v-model="form.snmp_v3_auth_protocol">
              <el-option v-for="item in ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512']" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="needsAuth" label="认证密码">
            <el-input v-model="form.snmp_v3_auth_passphrase" type="password" show-password />
          </el-form-item>
          <el-form-item v-if="needsPrivacy" label="加密算法">
            <el-select v-model="form.snmp_v3_priv_protocol">
              <el-option v-for="item in ['DES', 'AES', 'AES192', 'AES256', 'AES192C', 'AES256C']" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="needsPrivacy" label="加密密码">
            <el-input v-model="form.snmp_v3_priv_passphrase" type="password" show-password />
          </el-form-item>
          <el-form-item label="Context">
            <el-input v-model="form.snmp_v3_context_name" placeholder="可选" />
          </el-form-item>
        </template>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
        <el-form-item>
          <el-button type="success" native-type="submit">添加设备</el-button>
        </el-form-item>
      </div>
    </el-form>

    <el-table v-loading="loading" :data="filteredDevices" row-key="id" empty-text="暂无设备">
      <el-table-column prop="id" label="ID" width="90" />
      <el-table-column label="名称" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <RouterLink class="device-name-link" :to="`/devices/${row.id}`">{{ row.name }}</RouterLink>
        </template>
      </el-table-column>
      <el-table-column prop="host" label="地址" min-width="160" />
      <el-table-column prop="group_name" label="分组" min-width="140">
        <template #default="{ row }">{{ row.group_name || '未分组' }}</template>
      </el-table-column>
      <el-table-column prop="snmp_version" label="SNMP" width="110">
        <template #default="{ row }">
          <el-tag :type="row.snmp_version === '3' ? 'warning' : 'info'">v{{ row.snmp_version || '2c' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="port" label="端口" width="100" />
      <el-table-column label="采集状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" width="220" />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button type="danger" link :loading="deletingId === row.id" @click="removeDevice(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 4px 16px;
  align-items: start;
}

.device-form {
  margin-bottom: 18px;
  padding: 18px 18px 2px;
  border: 1px solid #edf0f7;
  border-radius: 16px;
  background: #fbfcff;
}

.device-name-link {
  color: #2563eb;
  font-weight: 700;
  text-decoration: none;
}
</style>
