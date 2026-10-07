<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getEmailNotificationConfig, saveEmailNotificationConfig, sendTestEmail, type EmailNotificationConfig } from '../services/api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; tested: [] }>()
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const passwordConfigured = ref(false)
const clearPassword = ref(false)
const recipients = ref('')
const password = ref('')
const form = reactive({
  emailEnabled: false, emailTo: [] as string[], sendResolved: true,
  subjectPrefix: '[SNMP Monitor]', smtpHost: '', smtpPort: 587, smtpFrom: '',
  smtpUsername: '', smtpTlsMode: 'starttls' as EmailNotificationConfig['smtpTlsMode']
})

function applyConfig(config: EmailNotificationConfig): void {
  for (const key of ['emailEnabled', 'emailTo', 'sendResolved', 'subjectPrefix', 'smtpHost', 'smtpPort', 'smtpFrom', 'smtpUsername', 'smtpTlsMode'] as const) {
    Object.assign(form, { [key]: config[key] })
  }
  recipients.value = config.emailTo.join('\n')
  passwordConfigured.value = config.smtpPasswordConfigured
  password.value = ''
  clearPassword.value = false
}

watch(() => props.modelValue, async (visible) => {
  if (!visible) { password.value = ''; return }
  loaded.value = false
  loading.value = true
  try {
    applyConfig(await getEmailNotificationConfig())
    loaded.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取邮件配置失败')
  } finally {
    loading.value = false
  }
})

async function save(test: boolean): Promise<void> {
  if (saving.value || !loaded.value) return
  const targets = [...new Set(recipients.value.split(/[,;\n]/).map(value => value.trim()).filter(Boolean))]
  const mailbox = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/
  if (targets.some(value => !mailbox.test(value)) || (form.smtpFrom && !mailbox.test(form.smtpFrom))) {
    ElMessage.warning('请填写有效的发件邮箱和收件邮箱'); return
  }
  if ((form.emailEnabled || test) && (!form.smtpHost.trim() || !form.smtpFrom.trim() || !targets.length)) {
    ElMessage.warning('请填写 SMTP 地址、发件邮箱和收件邮箱'); return
  }
  saving.value = true
  try {
    applyConfig(await saveEmailNotificationConfig({ ...form, emailTo: targets, smtpPassword: password.value, clearPassword: clearPassword.value }))
    ElMessage.success('邮件配置已保存，无需重启服务')
    if (test) {
      const result = await sendTestEmail()
      ElMessage.success(`测试邮件已入队：${result.notifications.length} 封，请在通知记录中查看发送结果`)
      emit('tested')
    } else {
      emit('update:modelValue', false)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '邮件配置操作失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="邮件通知配置" width="640px" align-center :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading">
      <el-alert title="保存后自动生效；测试邮件的最终结果可在邮件通知记录中查看。" type="info" :closable="false" style="margin-bottom: 20px" />
      <el-form :model="form" label-width="110px" :disabled="!loaded || saving" @submit.prevent="save(false)">
        <el-form-item label="告警邮件通知"><el-switch v-model="form.emailEnabled" /><span class="email-help">关闭后不产生新的告警邮件，仍可发送测试邮件</span></el-form-item>
        <el-form-item label="SMTP 地址"><el-input v-model="form.smtpHost" placeholder="例如 smtp.qq.com" maxlength="253" /></el-form-item>
        <el-form-item label="加密方式"><el-select v-model="form.smtpTlsMode" style="width: 100%"><el-option label="STARTTLS（通常为 587 端口）" value="starttls" /><el-option label="SSL/TLS（通常为 465 端口）" value="implicit" /><el-option label="不加密（内部邮件服务器）" value="none" /></el-select></el-form-item>
        <el-form-item label="SMTP 端口"><el-input-number v-model="form.smtpPort" :min="1" :max="65535" /></el-form-item>
        <el-form-item label="登录账号"><el-input v-model="form.smtpUsername" placeholder="邮箱账号；无需认证的服务器可留空" autocomplete="off" maxlength="254" /></el-form-item>
        <el-form-item label="密码 / 授权码"><el-input v-model="password" type="password" show-password autocomplete="new-password" :placeholder="passwordConfigured ? '已设置，留空保留原密码' : '填写邮箱 SMTP 授权码或密码'" :disabled="clearPassword" maxlength="2048" /><el-checkbox v-if="passwordConfigured" v-model="clearPassword">清除已保存的密码</el-checkbox></el-form-item>
        <el-form-item label="发件邮箱"><el-input v-model="form.smtpFrom" placeholder="例如 monitor@example.com" maxlength="254" /></el-form-item>
        <el-form-item label="收件邮箱"><el-input v-model="recipients" type="textarea" :rows="2" placeholder="多个邮箱用换行、逗号或分号分隔" /></el-form-item>
        <el-form-item label="主题前缀"><el-input v-model="form.subjectPrefix" placeholder="[SNMP Monitor]" maxlength="150" /></el-form-item>
        <el-form-item label="恢复通知"><el-switch v-model="form.sendResolved" /><span class="email-help">告警恢复后发送邮件</span></el-form-item>
      </el-form>
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button :disabled="!loaded" :loading="saving" @click="save(true)">保存并发送测试邮件</el-button>
      <el-button type="primary" :disabled="!loaded" :loading="saving" @click="save(false)">保存配置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.email-help { margin-left: 12px; color: #64748b; font-size: 12px; line-height: 20px; }
</style>
