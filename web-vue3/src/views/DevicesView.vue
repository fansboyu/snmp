<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { createDevice, listDevices, type Device } from '../services/api'

const loading = ref(false)
const keyword = ref('')
const devices = ref<Device[]>([])
const form = reactive({
  name: '',
  host: '',
  port: 161,
  community: 'public',
  enabled: false
})

const filteredDevices = computed(() => {
  const normalized = keyword.value.trim().toLowerCase()
  if (!normalized) return devices.value
  return devices.value.filter((device) => `${device.name} ${device.host}`.toLowerCase().includes(normalized))
})

async function loadData(): Promise<void> {
  loading.value = true
  try {
    devices.value = await listDevices()
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

  await createDevice({ ...form })
  ElMessage.success('设备已添加')
  form.name = ''
  form.host = ''
  form.port = 161
  form.community = 'public'
  form.enabled = false
  await loadData()
}

onMounted(loadData)
</script>

<template>
  <el-card class="page-card" shadow="never">
    <div class="page-toolbar">
      <h2 class="page-title">设备管理</h2>
      <div class="toolbar-actions">
        <el-input v-model="keyword" placeholder="搜索设备名称或 IP" clearable />
        <el-button type="primary" :loading="loading" @click="loadData">刷新</el-button>
      </div>
    </div>

    <el-form class="device-form" :model="form" inline @submit.prevent="submit">
      <el-form-item label="名称">
        <el-input v-model="form.name" placeholder="例如 Core Switch" />
      </el-form-item>
      <el-form-item label="地址">
        <el-input v-model="form.host" placeholder="192.0.2.20" />
      </el-form-item>
      <el-form-item label="端口">
        <el-input-number v-model="form.port" :min="1" :max="65535" />
      </el-form-item>
      <el-form-item label="Community">
        <el-input v-model="form.community" />
      </el-form-item>
      <el-form-item label="启用">
        <el-switch v-model="form.enabled" />
      </el-form-item>
      <el-form-item>
        <el-button type="success" native-type="submit">添加设备</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="filteredDevices" row-key="id" empty-text="暂无设备">
      <el-table-column prop="id" label="ID" width="90" />
      <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
      <el-table-column prop="host" label="地址" min-width="160" />
      <el-table-column prop="port" label="端口" width="100" />
      <el-table-column label="采集状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" width="240" />
    </el-table>
  </el-card>
</template>
