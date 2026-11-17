<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getWeComNotificationConfig, saveWeComNotificationConfig, sendTestWeComNotification, type WeComNotificationConfig } from '../services/api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; tested: [] }>()
const loading = ref(false), saving = ref(false), loaded = ref(false), secretConfigured = ref(false), clearSecret = ref(false)
const usersText = ref(''), appSecret = ref('')
const form = reactive({ enabled: false, corpId: '', agentId: 0, userIds: [] as string[], sendResolved: true })

function applyConfig(config: WeComNotificationConfig) {
  Object.assign(form, { enabled: config.enabled, corpId: config.corpId, agentId: config.agentId, userIds: config.userIds, sendResolved: config.sendResolved })
  usersText.value = config.userIds.join('\n')
  secretConfigured.value = config.secretConfigured
  appSecret.value = ''
  clearSecret.value = false
}

watch(() => props.modelValue, async visible => {
  if (!visible) { appSecret.value = ''; return }
  loaded.value = false; loading.value = true
  try { applyConfig(await getWeComNotificationConfig()); loaded.value = true }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取企业微信配置失败') }
  finally { loading.value = false }
})

async function save(test: boolean) {
  if (saving.value || !loaded.value) return
  const userIds = [...new Set(usersText.value.split(/[;,\n]/).map(x => x.trim()).filter(Boolean))]
  if (test && !form.enabled) { ElMessage.warning('请先启用企业微信应用通知，再发送测试消息'); return }
  if ((form.enabled || test) && (!form.corpId.trim() || !Number.isInteger(form.agentId) || form.agentId <= 0 || !userIds.length || ((!secretConfigured.value || clearSecret.value) && !appSecret.value.trim()))) {
    ElMessage.warning('请填写企业 ID、AgentId、应用 Secret 和至少一个接收成员 UserID'); return
  }
  saving.value = true
  try {
    applyConfig(await saveWeComNotificationConfig({ ...form, userIds, appSecret: appSecret.value, clearSecret: clearSecret.value }))
    ElMessage.success('企业微信配置已保存')
    if (test) {
      const result = await sendTestWeComNotification()
      ElMessage.success(`测试消息已入队：${result.notifications.length} 条，请查看通知记录状态`)
      emit('tested')
    } else emit('update:modelValue', false)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '企业微信配置操作失败') }
  finally { saving.value = false }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="企业微信自建应用通知" width="680px" align-center :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading">
      <el-alert title="通知由后端 notifier 调用企业微信应用 API 发送。Secret 加密存储，不会回显；接收成员必须在企业应用可见范围内。" type="info" :closable="false" style="margin-bottom:18px" />
      <el-form :model="form" label-width="128px" :disabled="!loaded || saving" @submit.prevent="save(false)">
        <el-form-item label="应用通知"><el-switch v-model="form.enabled" /><span class="hint">启用后与邮件渠道并行发送</span></el-form-item>
        <el-form-item label="企业 ID"><el-input v-model="form.corpId" placeholder="企业微信管理后台的 CorpID" maxlength="128" /></el-form-item>
        <el-form-item label="AgentId"><el-input-number v-model="form.agentId" :min="1" :max="2147483647" /></el-form-item>
        <el-form-item label="应用 Secret"><el-input v-model="appSecret" type="password" show-password autocomplete="new-password" :disabled="clearSecret" :placeholder="secretConfigured ? '已配置，留空保留原 Secret' : '填写自建应用 Secret'" maxlength="2048" /><el-checkbox v-if="secretConfigured" v-model="clearSecret">清除已保存的 Secret</el-checkbox></el-form-item>
        <el-form-item label="接收成员 UserID"><el-input v-model="usersText" type="textarea" :rows="3" placeholder="填写企业微信成员 UserID；多个成员每行一个，最多 100 个" /></el-form-item>
        <el-form-item label="告警恢复通知"><el-switch v-model="form.sendResolved" /><span class="hint">恢复时也向上述成员发送消息</span></el-form-item>
      </el-form>
      <p class="hint">需在企业微信管理后台创建自建应用，并确认应用可信 IP、成员可见范围和发送应用消息权限已配置。成员 UserID 区分大小写。</p>
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button :disabled="!loaded" :loading="saving" @click="save(true)">保存并发送测试消息</el-button>
      <el-button type="primary" :disabled="!loaded" :loading="saving" @click="save(false)">保存配置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>.hint{margin-left:10px;color:#64748b;font-size:12px;line-height:20px}</style>
