import { createCipheriv, createHash, randomBytes } from 'node:crypto'

export function emailTargets(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,;\n]/)
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))]
}

function encryptPassword(password, secret) {
  if (!password) return ''
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce)
  return Buffer.concat([nonce, cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

export async function loadMailConfig(app) {
  const result = await app.db.query('select config from email_notification_config where id = 1')
  if (result.rows[0]) return { ...result.rows[0].config, source: 'database' }
  return {
    emailEnabled: process.env.ALERT_EMAIL_ENABLED === 'true',
    emailTo: emailTargets(process.env.ALERT_EMAIL_TO),
    sendResolved: process.env.ALERT_EMAIL_SEND_RESOLVED !== 'false',
    subjectPrefix: process.env.ALERT_EMAIL_SUBJECT_PREFIX || '[SNMP Monitor]',
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpFrom: process.env.SMTP_FROM || '',
    smtpUsername: process.env.SMTP_USERNAME || '',
    encryptedPassword: encryptPassword(process.env.SMTP_PASSWORD || '', app.config.JWT_SECRET),
    smtpTlsMode: process.env.SMTP_TLS_MODE || 'starttls',
    source: 'environment'
  }
}

export function publicMailConfig(config) {
  const { encryptedPassword, ...visible } = config
  return { ...visible, smtpPasswordConfigured: Boolean(encryptedPassword), emailToConfigured: config.emailTo.length > 0 }
}

export function updatedMailConfig(current, body, secret) {
  const fields = ['emailEnabled', 'emailTo', 'sendResolved', 'subjectPrefix', 'smtpHost', 'smtpPort', 'smtpFrom', 'smtpUsername', 'smtpTlsMode']
  const config = { ...current }
  for (const field of fields) if (Object.hasOwn(body, field)) config[field] = body[field]
  for (const field of ['subjectPrefix', 'smtpHost', 'smtpFrom', 'smtpUsername']) config[field] = String(config[field]).trim()
  config.emailTo = emailTargets(config.emailTo)
  const mailbox = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/
  if (config.emailTo.length > 100 || config.emailTo.some(value => !mailbox.test(value))) throw new Error('请输入有效的收件邮箱，最多 100 个')
  if (config.smtpFrom && !mailbox.test(config.smtpFrom)) throw new Error('请输入有效的发件邮箱')
  if (/[\r\n]/.test(config.subjectPrefix) || /[\s/:\\]/.test(config.smtpHost)) throw new Error('邮件主题前缀或 SMTP 地址格式不正确')
  if (config.emailEnabled && (!config.smtpHost || !config.smtpFrom || !config.emailTo.length)) throw new Error('启用邮件通知前，请填写 SMTP 地址、发件邮箱和收件邮箱')
  if (body.clearPassword) config.encryptedPassword = ''
  if (body.smtpPassword) config.encryptedPassword = encryptPassword(body.smtpPassword, secret)
  delete config.source
  return config
}

export const mailConfigSchema = {
  body: {
    type: 'object', additionalProperties: false,
    properties: {
      emailEnabled: { type: 'boolean' }, sendResolved: { type: 'boolean' },
      emailTo: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 254 } },
      subjectPrefix: { type: 'string', maxLength: 150 }, smtpHost: { type: 'string', maxLength: 253 },
      smtpPort: { type: 'integer', minimum: 1, maximum: 65535 }, smtpFrom: { type: 'string', maxLength: 254 },
      smtpUsername: { type: 'string', maxLength: 254 }, smtpPassword: { type: 'string', maxLength: 2048 },
      smtpTlsMode: { type: 'string', enum: ['starttls', 'implicit', 'none'] }, clearPassword: { type: 'boolean' }
    }
  }
}
