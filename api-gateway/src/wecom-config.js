import { createCipheriv, createHash, randomBytes } from 'node:crypto'

function encryptSecret(value, secret) {
  if (!value) return ''
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce)
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

export async function loadWeComConfig(app) {
  const result = await app.db.query('select config from wecom_app_notification_config where id = 1')
  return result.rows[0] ? { ...result.rows[0].config, source: 'database' } : {
    enabled: false, corpId: '', agentId: 0, userIds: [], sendResolved: true,
    encryptedSecret: '', source: 'database'
  }
}

export function publicWeComConfig(config) {
  const { encryptedSecret, ...visible } = config
  return { ...visible, secretConfigured: Boolean(encryptedSecret) }
}

export function updatedWeComConfig(current, body, secret) {
  const config = { ...current }
  for (const key of ['enabled', 'corpId', 'agentId', 'userIds', 'sendResolved']) {
    if (Object.hasOwn(body, key)) config[key] = body[key]
  }
  config.corpId = String(config.corpId || '').trim()
  config.agentId = Number(config.agentId || 0)
  config.userIds = [...new Set((Array.isArray(config.userIds) ? config.userIds : String(config.userIds || '').split(/[;,\n]/))
    .map(value => String(value).trim()).filter(Boolean))]
  if (config.corpId.length > 128 || /[\s&?]/.test(config.corpId)) throw new Error('企业 ID 格式不正确')
  if (!Number.isInteger(config.agentId) || config.agentId < 0 || config.agentId > 2147483647) throw new Error('AgentId 必须是有效的非负整数')
  if (config.userIds.length > 100 || config.userIds.some(id => id.length > 128 || /[|\s\u0000-\u001f]/.test(id) || id === '@all')) {
    throw new Error('成员 UserID 无效；最多配置 100 个成员，暂不支持全员发送')
  }
  if (body.clearSecret) config.encryptedSecret = ''
  const appSecret = String(body.appSecret || '').trim()
  if (appSecret) config.encryptedSecret = encryptSecret(appSecret, secret)
  if (config.enabled && (!config.corpId || !config.agentId || !config.encryptedSecret || !config.userIds.length)) {
    throw new Error('启用企业微信通知前，请填写企业 ID、AgentId、应用 Secret 和接收成员 UserID')
  }
  delete config.source
  return config
}

export const weComConfigSchema = {
  body: {
    type: 'object', additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' }, corpId: { type: 'string', maxLength: 128 },
      agentId: { type: 'integer', minimum: 0, maximum: 2147483647 },
      userIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
      sendResolved: { type: 'boolean' }, appSecret: { type: 'string', maxLength: 2048 }, clearSecret: { type: 'boolean' }
    }
  }
}
