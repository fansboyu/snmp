<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentCopy, Download, Lock, Refresh, Timer } from '@element-plus/icons-vue'
import {
  downloadConfigBackup,
  getConfigBackupDiff,
  getConfigBackupJobs,
  getConfigBackupOverview,
  getConfigBackupProfile,
  getConfigBackupVersions,
  requestConfigBackup,
  saveConfigBackupProfile,
  type ConfigBackupDiff,
  type ConfigBackupProfile,
  type ConfigBackupRow,
  type ConfigBackupVersion
} from '../services/api'

const loading = ref(false)
const rows = ref<ConfigBackupRow[]>([])
const jobs = ref<Array<Record<string, unknown>>>([])
const configureVisible = ref(false)
const historyVisible = ref(false)
const diffVisible = ref(false)
const saving = ref(false)
const selected = ref<ConfigBackupRow | null>(null)
const versions = ref<ConfigBackupVersion[]>([])
const selectedDiff = ref<ConfigBackupDiff | null>(null)
const diffVersion = ref<ConfigBackupVersion | null>(null)
const profile = reactive({
  protocol: 'ssh' as 'ssh' | 'netconf',
  platform: 'huawei_vrp' as ConfigBackupProfile['platform'],
  port: 22,
  username: '',
  host_key_fingerprint: '',
  enabled: false,
  interval_hours: 24,
  retention_count: 30,
  password: '',
  private_key: '',
  private_key_passphrase: '',
  credential_configured: false
})
const credentialMode = ref<'password' | 'private_key'>('password')
const configuredCount = computed(() => rows.value.filter((row) => row.credential_configured).length)
const changedCount = computed(() => rows.value.filter((row) => row.latest_changed === true).length)
const failedCount = computed(() => rows.value.filter((row) => row.latest_job_status === 'failed').length)

function dateTime(value?: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('zh-CN', { hour12: false })
}
function platformName(value?: string | null): string {
  return ({ cisco_ios: 'Cisco IOS', huawei_vrp: 'Huawei VRP', h3c_comware: 'H3C Comware' } as Record<string, string>)[value || ''] || '未配置'
}
function statusType(value?: string | null): 'success' | 'warning' | 'danger' | 'info' {
  if (value === 'succeeded') return 'success'
  if (value === 'running' || value === 'queued') return 'warning'
  if (value === 'failed') return 'danger'
  return 'info'
}
function statusName(value?: string | null): string {
  return ({ succeeded: '成功', running: '执行中', queued: '排队中', failed: '失败' } as Record<string, string>)[value || ''] || '暂无备份'
}
function bytes(value?: number | null): string {
  if (!value) return '—'
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const [overview, taskResult] = await Promise.all([getConfigBackupOverview(), getConfigBackupJobs()])
    rows.value = overview.items
    jobs.value = taskResult.items.slice(0, 12)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取配置备份状态失败')
  } finally { loading.value = false }
}

async function configure(row: ConfigBackupRow): Promise<void> {
  selected.value = row
  try {
    const saved = await getConfigBackupProfile(row.device_id)
    Object.assign(profile, saved, { password: '', private_key: '', private_key_passphrase: '' })
    credentialMode.value = saved.auth_mode || 'password'
    configureVisible.value = true
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取配置失败') }
}

async function saveProfile(): Promise<void> {
  if (!selected.value) return
  saving.value = true
  try {
    const payload = {
      protocol: profile.protocol,
      platform: profile.platform,
      port: profile.port,
      username: profile.username,
      host_key_fingerprint: profile.host_key_fingerprint,
      enabled: profile.enabled,
      interval_hours: profile.interval_hours,
      retention_count: profile.retention_count,
      password: credentialMode.value === 'password' ? profile.password : '',
      private_key: credentialMode.value === 'private_key' ? profile.private_key : '',
      private_key_passphrase: credentialMode.value === 'private_key' ? profile.private_key_passphrase : ''
    }
    await saveConfigBackupProfile(selected.value.device_id, payload)
    ElMessage.success('备份配置已保存')
    configureVisible.value = false
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '保存配置失败') }
  finally { saving.value = false }
}

async function runNow(row: ConfigBackupRow): Promise<void> {
  try {
    await requestConfigBackup(row.device_id)
    ElMessage.success(`已加入 ${row.device_name} 的配置备份队列`)
    await refresh()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '创建备份任务失败') }
}

async function openHistory(row: ConfigBackupRow): Promise<void> {
  selected.value = row
  try {
    versions.value = (await getConfigBackupVersions(row.device_id)).items
    historyVisible.value = true
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取历史版本失败') }
}

async function showDiff(version: ConfigBackupVersion): Promise<void> {
  try {
    diffVersion.value = version
    selectedDiff.value = await getConfigBackupDiff(version.id)
    diffVisible.value = true
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '读取差异失败') }
}

async function downloadVersion(version: ConfigBackupVersion): Promise<void> {
  try {
    await ElMessageBox.confirm('配置文件可能包含口令、密钥、SNMP community 和网络拓扑信息。请只保存到受控位置。确定下载此版本吗？', '下载敏感配置', { type: 'warning', confirmButtonText: '下载配置', cancelButtonText: '取消' })
    const blob = await downloadConfigBackup(version.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `device-${version.device_id}-${version.created_at.replace(/:/g, '-')}.cfg`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error instanceof Error ? error.message : '下载配置失败')
  }
}

onMounted(refresh)
</script>

<template>
  <div class="backup-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">CONFIGURATION SAFETY</div>
        <h1>配置备份</h1>
        <p>通过 SSH 定时保存设备运行配置，查看变更并安全取回历史版本。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
    </header>

    <div class="security-note">
      <el-icon><Lock /></el-icon>
      <span>配置正文与 SSH 凭据采用 AES-256-GCM 加密存储。下载会解密并记录操作；修改部署的 JWT_SECRET 会导致已存配置无法解密。</span>
    </div>

    <section class="summary-grid">
      <el-card shadow="never"><span>已配置凭据</span><strong>{{ configuredCount }}</strong><small>台设备</small></el-card>
      <el-card shadow="never"><span>检测到配置变化</span><strong>{{ changedCount }}</strong><small>最新版本较前一版本变化</small></el-card>
      <el-card shadow="never"><span>最近备份失败</span><strong :class="{ danger: failedCount > 0 }">{{ failedCount }}</strong><small>需要检查连接、账号或指纹</small></el-card>
    </section>

    <el-card shadow="never" class="table-card">
      <template #header><div class="card-heading"><div><b>设备配置状态</b><span>SSH 只读采集；NETCONF 当前仅预留接口</span></div><el-tag type="info">数据保留在 PostgreSQL</el-tag></div></template>
      <el-table :data="rows" v-loading="loading" row-key="device_id" empty-text="暂无纳管设备">
        <el-table-column label="设备" min-width="190"><template #default="scope"><b>{{ scope.row.device_name }}</b><small class="subline">{{ scope.row.host }}</small></template></el-table-column>
        <el-table-column label="适配器" width="155"><template #default="scope">{{ platformName(scope.row.platform) }}</template></el-table-column>
        <el-table-column label="自动备份" width="120"><template #default="scope"><el-tag :type="scope.row.enabled ? 'success' : 'info'">{{ scope.row.enabled ? `每 ${scope.row.interval_hours} 小时` : '未启用' }}</el-tag></template></el-table-column>
        <el-table-column label="最近任务" min-width="190"><template #default="scope"><el-tag :type="statusType(scope.row.latest_job_status)">{{ statusName(scope.row.latest_job_status) }}</el-tag><small class="subline">{{ dateTime(scope.row.latest_job_finished_at || scope.row.latest_job_requested_at) }}</small><small v-if="scope.row.latest_job_error" class="error-line">{{ scope.row.latest_job_error }}</small></template></el-table-column>
        <el-table-column label="最近版本" min-width="180"><template #default="scope"><template v-if="scope.row.latest_version_id"><span>{{ dateTime(scope.row.latest_version_at) }}</span><small class="subline">{{ bytes(scope.row.latest_size_bytes) }} · {{ scope.row.latest_changed ? '配置有变化' : '基线/无变化' }}</small></template><span v-else class="muted">尚无成功备份</span></template></el-table-column>
        <el-table-column label="操作" width="268" fixed="right"><template #default="scope"><div class="actions"><el-button text type="primary" @click="configure(scope.row)">配置</el-button><el-button text type="primary" :disabled="!scope.row.credential_configured || ['queued','running'].includes(scope.row.latest_job_status || '')" @click="runNow(scope.row)">立即备份</el-button><el-button text :disabled="!scope.row.latest_version_id" @click="openHistory(scope.row)">历史版本</el-button></div></template></el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="table-card task-card">
      <template #header><div class="card-heading"><div><b>最近任务</b><span>失败任务最多自动重试 3 次</span></div><el-icon><Timer /></el-icon></div></template>
      <el-table :data="jobs" size="small" empty-text="暂无任务">
        <el-table-column prop="device_name" label="设备" min-width="150" />
        <el-table-column label="触发方式" width="110"><template #default="scope">{{ scope.row.trigger_type === 'manual' ? '手动' : '计划' }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="scope"><el-tag :type="statusType(String(scope.row.status))">{{ statusName(String(scope.row.status)) }}</el-tag></template></el-table-column>
        <el-table-column label="时间" min-width="180"><template #default="scope">{{ dateTime(String(scope.row.finished_at || scope.row.requested_at || '')) }}</template></el-table-column>
        <el-table-column label="重试" width="90"><template #default="scope">{{ scope.row.attempts || 0 }}/3</template></el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="configureVisible" :title="`配置 SSH 备份 · ${selected?.device_name || ''}`" width="min(720px, 94vw)" destroy-on-close>
      <el-alert type="warning" :closable="false" title="请使用只读权限账号。运行配置可能包含密码和密钥；下载前会再次确认。" />
      <el-form label-position="top" class="profile-form">
        <el-form-item label="传输接口"><el-select v-model="profile.protocol" class="full" disabled><el-option label="SSH CLI（当前可用）" value="ssh"/><el-option label="NETCONF（接口预留）" value="netconf" disabled /></el-select></el-form-item>
        <div class="form-grid">
          <el-form-item label="设备命令模板"><el-select v-model="profile.platform" class="full"><el-option label="Huawei VRP" value="huawei_vrp"/><el-option label="H3C Comware" value="h3c_comware"/><el-option label="Cisco IOS" value="cisco_ios"/></el-select></el-form-item>
          <el-form-item label="SSH 端口"><el-input-number v-model="profile.port" :min="1" :max="65535" class="full" /></el-form-item>
          <el-form-item label="SSH 用户名"><el-input v-model="profile.username" autocomplete="off" /></el-form-item>
          <el-form-item label="主机密钥指纹"><el-input v-model="profile.host_key_fingerprint" placeholder="SHA256:..." /></el-form-item>
        </div>
        <el-form-item label="认证方式"><el-radio-group v-model="credentialMode"><el-radio-button value="password">密码</el-radio-button><el-radio-button value="private_key">私钥</el-radio-button></el-radio-group><div v-if="profile.credential_configured" class="credential-hint">已保存的凭据不会回传；留空表示继续使用。</div></el-form-item>
        <el-form-item v-if="credentialMode === 'password'" label="SSH 密码"><el-input v-model="profile.password" type="password" show-password autocomplete="new-password" placeholder="留空保留已保存密码" /></el-form-item>
        <template v-else><el-form-item label="SSH 私钥（PEM / OpenSSH）"><el-input v-model="profile.private_key" type="textarea" :rows="5" autocomplete="off" placeholder="粘贴私钥；留空保留已保存凭据" /></el-form-item><el-form-item label="私钥口令（如有）"><el-input v-model="profile.private_key_passphrase" type="password" show-password autocomplete="new-password" /></el-form-item></template>
        <div class="form-grid">
          <el-form-item label="启用自动备份"><el-switch v-model="profile.enabled" /></el-form-item>
          <el-form-item label="备份周期（小时）"><el-input-number v-model="profile.interval_hours" :min="1" :max="720" class="full" /></el-form-item>
          <el-form-item label="保留最近版本数"><el-input-number v-model="profile.retention_count" :min="2" :max="365" class="full" /></el-form-item>
        </div>
        <div class="fingerprint-help">主机指纹用于防止 SSH 中间人攻击。请通过可信管理网或设备控制台预先核实，不要接受未经核验的指纹。</div>
      </el-form>
      <template #footer><el-button @click="configureVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveProfile">保存配置</el-button></template>
    </el-dialog>

    <el-drawer v-model="historyVisible" :title="`${selected?.device_name || ''} · 配置版本`" size="min(760px, 96vw)">
      <el-table :data="versions" empty-text="暂无备份版本">
        <el-table-column label="版本时间" min-width="180"><template #default="scope">{{ dateTime(scope.row.created_at) }}</template></el-table-column>
        <el-table-column label="变化" width="130"><template #default="scope"><el-tag :type="scope.row.baseline ? 'info' : (scope.row.changed ? 'warning' : (scope.row.previous_version_id ? 'success' : 'info'))">{{ scope.row.baseline ? '初始基线' : (scope.row.previous_version_id ? (scope.row.changed ? '有变化' : '无变化') : '对照已过期') }}</el-tag></template></el-table-column>
        <el-table-column label="大小" width="90"><template #default="scope">{{ bytes(scope.row.size_bytes) }}</template></el-table-column>
        <el-table-column label="SHA-256" min-width="140"><template #default="scope"><code>{{ scope.row.sha256.slice(0, 12) }}…</code></template></el-table-column>
        <el-table-column label="操作" width="150"><template #default="scope"><el-button text type="primary" @click="showDiff(scope.row)">查看差异</el-button><el-button text :icon="Download" @click="downloadVersion(scope.row)">下载</el-button></template></el-table-column>
      </el-table>
    </el-drawer>

    <el-drawer v-model="diffVisible" :title="`配置差异 · ${dateTime(diffVersion?.created_at)}`" size="min(860px, 96vw)">
      <el-alert v-if="selectedDiff?.baseline" type="info" :closable="false" title="这是该设备的第一个配置版本，作为后续比较的基线。" />
      <el-alert v-else-if="selectedDiff && !selectedDiff.details_available" type="warning" :closable="false" :title="selectedDiff.message || '配置过大，无法在线比较。'" />
      <template v-else-if="selectedDiff">
        <el-alert type="info" :closable="false" title="密码、Secret、community、预共享密钥等敏感配置值已脱敏；原始文件仅在明确下载后提供。" />
        <div class="diff-columns"><section><h3>新增 {{ selectedDiff.added.length }} 行</h3><pre v-if="selectedDiff.added.length">{{ selectedDiff.added.map(line => '+ ' + line).join('\n') }}</pre><el-empty v-else description="无新增行" :image-size="48" /></section><section><h3>删除 {{ selectedDiff.removed.length }} 行</h3><pre v-if="selectedDiff.removed.length">{{ selectedDiff.removed.map(line => '− ' + line).join('\n') }}</pre><el-empty v-else description="无删除行" :image-size="48" /></section></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.backup-page{max-width:1500px;margin:0 auto;color:#26354a}.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.page-header h1{font-size:25px;margin:4px 0 6px}.page-header p{color:#718096;margin:0}.eyebrow{font-size:11px;letter-spacing:.14em;color:#3c8dbc;font-weight:700}.security-note{display:flex;gap:10px;align-items:flex-start;padding:12px 15px;margin-bottom:18px;border:1px solid #d9e9f7;background:#f3f9ff;border-radius:9px;color:#526b83;font-size:13px}.security-note .el-icon{color:#3083bd;font-size:17px}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}.summary-grid .el-card{border-radius:12px}.summary-grid span,.summary-grid small{display:block;color:#8291a5;font-size:13px}.summary-grid strong{display:block;font-size:29px;margin:9px 0 4px;color:#3286d8}.summary-grid strong.danger{color:#e05252}.table-card{border-radius:12px;margin-bottom:18px}.card-heading{display:flex;justify-content:space-between;align-items:center}.card-heading b{font-size:15px}.card-heading span{display:block;color:#8997a8;font-size:12px;margin-top:4px}.subline{display:block;color:#8795a5;font-size:12px;margin-top:4px}.error-line{display:block;color:#d94b4b;font-size:12px;margin-top:4px;max-width:240px;white-space:normal}.muted{color:#9aa6b2}.actions{display:flex;align-items:center;gap:2px}.task-card{margin-top:18px}.profile-form{margin-top:18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.full{width:100%}.credential-hint,.fingerprint-help{font-size:12px;color:#76869a;margin-left:12px}.fingerprint-help{margin:0 0 8px 0;line-height:1.6}.diff-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}.diff-columns section{min-width:0;border:1px solid #e5eaf0;border-radius:9px;padding:12px}.diff-columns h3{font-size:14px;margin:0 0 10px}.diff-columns pre{background:#f7f9fb;padding:12px;max-height:65vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,monospace;color:#405367}.diff-columns section:first-child h3{color:#188652}.diff-columns section:last-child h3{color:#c24c4c}@media(max-width:800px){.summary-grid{grid-template-columns:1fr}.form-grid,.diff-columns{grid-template-columns:1fr}.page-header{align-items:flex-start;gap:12px}.actions{flex-wrap:wrap}}
</style>
