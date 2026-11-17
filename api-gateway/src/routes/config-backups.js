import { createHash } from 'node:crypto'
import { decryptConfigBackup, decryptConfigCredential, encryptConfigCredential } from '../config-backup-crypto.js'

const allowedPlatforms = new Set(['cisco_ios', 'huawei_vrp', 'h3c_comware'])
const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/
const maxDiffCells = 1_500_000
const redactedKeywords = /\b(password|secret|community|pre-shared-key|authentication-key|private-key|key-string|key|psk|token|cipher)\b\s+(.+)$/i

function safeProfile(row) {
  if (!row) return { enabled: false, protocol: 'ssh', platform: 'huawei_vrp', port: 22, username: '', host_key_fingerprint: '', interval_hours: 24, retention_count: 30, credential_configured: false }
  const { credential_ciphertext, ...profile } = row
  return { ...profile, credential_configured: Boolean(credential_ciphertext) }
}

function validId(value) { return /^\d+$/.test(String(value)) }

export async function configBackupRoutes(app) {
  app.get('/', async (request) => {
    const { q = '', status = '' } = request.query ?? {}
    const result = await app.db.query(`
      select d.id as device_id,d.name as device_name,host(d.host) as host,
        coalesce(p.enabled,false) as enabled,p.protocol,p.platform,p.interval_hours,p.retention_count,
        (p.credential_ciphertext is not null and p.credential_ciphertext <> '') as credential_configured,
        p.last_backup_at,
        latest.id as latest_version_id,latest.created_at as latest_version_at,
        latest.sha256 as latest_sha256,latest.changed as latest_changed,latest.size_bytes as latest_size_bytes,
        job.id as latest_job_id,job.status as latest_job_status,job.trigger_type as latest_job_trigger,
        job.requested_at as latest_job_requested_at,job.finished_at as latest_job_finished_at,
        job.error_message as latest_job_error,job.attempts as latest_job_attempts
      from devices d
      left join device_config_backup_profiles p on p.device_id=d.id
      left join lateral (select * from device_config_backup_versions v where v.device_id=d.id order by v.created_at desc,v.id desc limit 1) latest on true
      left join lateral (select * from device_config_backup_jobs j where j.device_id=d.id order by j.requested_at desc,j.id desc limit 1) job on true
      where ($1='' or d.name ilike '%'||$1||'%' or d.host::text ilike '%'||$1||'%')
        and ($2='' or job.status=$2)
      order by d.name,d.id
    `, [String(q).slice(0,120), String(status)])
    return { items: result.rows }
  })

  app.get('/devices/:deviceId/profile', async (request, reply) => {
    const { deviceId } = request.params
    if (!validId(deviceId)) return reply.code(400).send({ message: '无效设备 ID' })
    const device = await app.db.query('select id from devices where id=$1', [deviceId])
    if (!device.rowCount) return reply.code(404).send({ message: '设备不存在' })
    const result = await app.db.query('select * from device_config_backup_profiles where device_id=$1', [deviceId])
    return safeProfile(result.rows[0])
  })

  app.put('/devices/:deviceId/profile', async (request, reply) => {
    const { deviceId } = request.params
    if (!validId(deviceId)) return reply.code(400).send({ message: '无效设备 ID' })
    const body = request.body ?? {}
    const protocol = body.protocol ?? 'ssh'
    const platform = body.platform
    const port = Number(body.port ?? 22)
    const intervalHours = Number(body.interval_hours ?? 24)
    const retentionCount = Number(body.retention_count ?? 30)
    const username = String(body.username ?? '').trim()
    const fingerprint = String(body.host_key_fingerprint ?? '').trim()
    const enabled = body.enabled === true
    if (protocol !== 'ssh') return reply.code(400).send({ message: 'NETCONF 接口已预留，当前版本仅支持 SSH' })
    if (!allowedPlatforms.has(platform)) return reply.code(400).send({ message: '请选择支持的设备命令模板' })
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reply.code(400).send({ message: 'SSH 端口范围应为 1–65535' })
    if (!username || username.length > 128) return reply.code(400).send({ message: 'SSH 用户名不能为空且不能超过 128 个字符' })
    if (!fingerprintPattern.test(fingerprint)) return reply.code(400).send({ message: '请输入设备 SSH 主机密钥 SHA256 指纹' })
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 720) return reply.code(400).send({ message: '备份周期应为 1–720 小时' })
    if (!Number.isInteger(retentionCount) || retentionCount < 2 || retentionCount > 365) return reply.code(400).send({ message: '保留版本数应为 2–365' })

    const currentResult = await app.db.query('select credential_ciphertext,auth_mode from device_config_backup_profiles where device_id=$1', [deviceId])
    if (!currentResult.rowCount) {
      const device = await app.db.query('select id from devices where id=$1', [deviceId])
      if (!device.rowCount) return reply.code(404).send({ message: '设备不存在' })
    }
    let encryptedCredential = currentResult.rows[0]?.credential_ciphertext ?? ''
    let authMode = currentResult.rows[0]?.auth_mode ?? 'password'
    if (body.clearCredential === true) encryptedCredential = ''
    const password = String(body.password ?? '')
    const privateKey = String(body.private_key ?? '')
    const privateKeyPassphrase = String(body.private_key_passphrase ?? '')
    if (password || privateKey) {
      if (password && privateKey) return reply.code(400).send({ message: '请仅配置密码或私钥中的一种认证方式' })
      if (password.length > 4096 || privateKey.length > 32768 || privateKeyPassphrase.length > 4096) return reply.code(400).send({ message: 'SSH 凭据超出允许长度' })
      encryptedCredential = encryptConfigCredential({ password, privateKey, privateKeyPassphrase }, app.config.JWT_SECRET)
      authMode = privateKey ? 'private_key' : 'password'
    }
    if (body.clearCredential === true && !password && !privateKey) authMode = 'password'
    if (enabled && !encryptedCredential) return reply.code(400).send({ message: '启用自动备份前请先保存 SSH 密码或私钥' })

    const result = await app.db.query(`
      insert into device_config_backup_profiles
        (device_id,protocol,platform,port,username,auth_mode,credential_ciphertext,host_key_fingerprint,enabled,interval_hours,retention_count)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict(device_id) do update set
        protocol=excluded.protocol,platform=excluded.platform,port=excluded.port,username=excluded.username,auth_mode=excluded.auth_mode,
        credential_ciphertext=excluded.credential_ciphertext,host_key_fingerprint=excluded.host_key_fingerprint,
        enabled=excluded.enabled,interval_hours=excluded.interval_hours,retention_count=excluded.retention_count,
        next_backup_at=case when device_config_backup_profiles.enabled is distinct from excluded.enabled then now() else device_config_backup_profiles.next_backup_at end,
        updated_at=now()
      returning device_id,protocol,platform,port,username,auth_mode,host_key_fingerprint,enabled,interval_hours,retention_count,last_backup_at,credential_ciphertext
    `, [deviceId, protocol, platform, port, username, authMode, encryptedCredential, fingerprint, enabled, intervalHours, retentionCount])
    return safeProfile(result.rows[0])
  })

  app.post('/devices/:deviceId/run', async (request, reply) => {
    const { deviceId } = request.params
    if (!validId(deviceId)) return reply.code(400).send({ message: '无效设备 ID' })
    const profile = await app.db.query(`select credential_ciphertext from device_config_backup_profiles where device_id=$1`, [deviceId])
    if (!profile.rowCount || !profile.rows[0].credential_ciphertext) return reply.code(409).send({ message: '请先配置 SSH 认证和主机指纹' })
    const result = await app.db.query(`
      insert into device_config_backup_jobs(device_id,trigger_type,requested_by)
      values($1,'manual',$2) on conflict do nothing returning id,status,requested_at
    `, [deviceId, request.user?.username ?? 'unknown'])
    if (!result.rowCount) return reply.code(409).send({ message: '该设备已有配置备份任务正在排队或执行' })
    reply.code(202)
    return result.rows[0]
  })

  app.get('/devices/:deviceId/versions', async (request, reply) => {
    const { deviceId } = request.params
    if (!validId(deviceId)) return reply.code(400).send({ message: '无效设备 ID' })
    const result = await app.db.query(`
      select v.id,v.device_id,v.created_at,v.sha256,v.size_bytes,v.baseline,v.changed,v.previous_version_id,
        j.trigger_type,j.status
      from device_config_backup_versions v join device_config_backup_jobs j on j.id=v.job_id
      where v.device_id=$1 order by v.created_at desc,v.id desc limit 365
    `, [deviceId])
    return { items: result.rows }
  })

  app.get('/jobs', async (request) => {
    const result = await app.db.query(`
      select j.id,j.device_id,d.name as device_name,host(d.host) as host,j.trigger_type,j.status,
        j.requested_at,j.started_at,j.finished_at,j.error_message,j.attempts,j.version_id
      from device_config_backup_jobs j join devices d on d.id=j.device_id
      order by j.requested_at desc,j.id desc limit 200
    `)
    return { items: result.rows }
  })

  app.get('/versions/:versionId/download', async (request, reply) => {
    const { versionId } = request.params
    if (!validId(versionId)) return reply.code(400).send({ message: '无效备份版本 ID' })
    const result = await app.db.query(`
      select v.id,v.device_id,v.created_at,v.encrypted_content,d.name,d.host::text as host
      from device_config_backup_versions v join devices d on d.id=v.device_id where v.id=$1
    `, [versionId])
    if (!result.rowCount) return reply.code(404).send({ message: '备份版本不存在' })
    const row = result.rows[0]
    let content
    try { content = decryptConfigBackup(row.encrypted_content, app.config.JWT_SECRET) }
    catch { return reply.code(500).send({ message: '配置解密失败，请确认 JWT_SECRET 与备份时一致' }) }
    await audit(app, row.device_id, row.id, 'download', request.user?.username ?? 'unknown')
    const filename = `device-${row.device_id}-${new Date(row.created_at).toISOString().replaceAll(':','-')}.cfg`
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Cache-Control', 'no-store, private')
    return reply.send(content)
  })

  app.get('/versions/:versionId/diff', async (request, reply) => {
    const { versionId } = request.params
    if (!validId(versionId)) return reply.code(400).send({ message: '无效备份版本 ID' })
    const result = await app.db.query(`
      select v.id,v.device_id,v.created_at,v.encrypted_content,v.baseline,v.changed,v.previous_version_id,v.sha256,
        p.id as previous_id,p.encrypted_content as previous_content,p.created_at as previous_created_at
      from device_config_backup_versions v
      left join device_config_backup_versions p on p.id=v.previous_version_id
      where v.id=$1
    `, [versionId])
    if (!result.rowCount) return reply.code(404).send({ message: '备份版本不存在' })
    const row = result.rows[0]
    await audit(app, row.device_id, row.id, 'view_diff', request.user?.username ?? 'unknown')
    if (row.baseline) return { baseline: true, changed: false, added: [], removed: [], details_available: true }
    if (!row.previous_id) return { baseline: false, changed: row.changed, added: [], removed: [], details_available: false, message: '前一版本已按保留策略清理，无法在线比较。' }
    let current, previous
    try {
      current = decryptConfigBackup(row.encrypted_content, app.config.JWT_SECRET).toString('utf8')
      previous = decryptConfigBackup(row.previous_content, app.config.JWT_SECRET).toString('utf8')
    } catch { return reply.code(500).send({ message: '配置解密失败，请确认 JWT_SECRET 与备份时一致' }) }
    const diff = lineDiff(previous, current)
    if (!diff.available) return { baseline: false, changed: row.sha256 !== createHash('sha256').update(Buffer.from(previous)).digest('hex'), details_available: false, added: [], removed: [], message: '配置较大，无法在线生成逐行差异；请下载两个版本进行比较。' }
    return { baseline: false, changed: diff.added.length + diff.removed.length > 0, details_available: true, added: diff.added, removed: diff.removed, previous_created_at: row.previous_created_at }
  })
}

async function audit(app, deviceId, versionId, action, actor) {
  await app.db.query(`insert into device_config_backup_audit(device_id,version_id,action,actor) values($1,$2,$3,$4)`, [deviceId, versionId, action, actor])
}

function redactLine(line) {
  const match = line.match(redactedKeywords)
  if (!match) return line
  return `${line.slice(0, match.index + match[1].length)} <REDACTED>`
}

export function lineDiff(beforeText, afterText) {
  const beforeLineCount = countLines(beforeText)
  const afterLineCount = countLines(afterText)
  if ((beforeLineCount + 1) * (afterLineCount + 1) > maxDiffCells) return { available: false, added: [], removed: [] }
  const beforeRaw = beforeText.split(/\r?\n/)
  const afterRaw = afterText.split(/\r?\n/)
  const before = beforeRaw.map(redactLine)
  const after = afterRaw.map(redactLine)
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = beforeRaw[i] === afterRaw[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const added = [], removed = []
  let i = 0, j = 0
  while (i < before.length && j < after.length) {
    if (beforeRaw[i] === afterRaw[j]) { i++; j++; continue }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) removed.push(before[i++])
    else added.push(after[j++])
  }
  while (i < before.length) removed.push(before[i++])
  while (j < after.length) added.push(after[j++])
  return { available: true, added: added.slice(0, 2000), removed: removed.slice(0, 2000) }
}

function countLines(text) {
  let count = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
  return count
}
