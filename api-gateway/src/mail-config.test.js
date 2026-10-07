import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { updatedMailConfig, publicMailConfig } from './mail-config.js'

const initial = {
  emailEnabled: false, emailTo: [], sendResolved: true, subjectPrefix: '[SNMP Monitor]',
  smtpHost: '', smtpPort: 587, smtpFrom: '', smtpUsername: '', encryptedPassword: '', smtpTlsMode: 'starttls'
}

test('password is encrypted, never returned, retained on blank input and explicitly cleared', () => {
  const secret = 'test-only-secret'
  const saved = updatedMailConfig(initial, { smtpPassword: 'test-only-password' }, secret)
  assert.notEqual(saved.encryptedPassword, 'test-only-password')
  const packed = Buffer.from(saved.encryptedPassword, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(-16))
  assert.equal(Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString(), 'test-only-password')
  assert.equal(publicMailConfig(saved).smtpPasswordConfigured, true)
  assert.equal(Object.hasOwn(publicMailConfig(saved), 'encryptedPassword'), false)
  assert.equal(updatedMailConfig(saved, { smtpPassword: '' }, secret).encryptedPassword, saved.encryptedPassword)
  assert.equal(updatedMailConfig(saved, { clearPassword: true }, secret).encryptedPassword, '')
})

test('enabled configuration requires complete delivery fields and rejects header injection', () => {
  assert.throws(() => updatedMailConfig(initial, { emailEnabled: true }, 'test'), /SMTP/)
  assert.throws(() => updatedMailConfig(initial, { smtpFrom: 'a@example.com\r\nBcc: victim@example.com' }, 'test'), /邮箱/)
  assert.throws(() => updatedMailConfig(initial, { subjectPrefix: 'prefix\r\nBcc: victim@example.com' }, 'test'), /格式/)
  const saved = updatedMailConfig(initial, { emailEnabled: true, smtpHost: 'smtp.example.com', smtpFrom: 'sender@example.com', emailTo: ['a@example.com', 'a@example.com'] }, 'test')
  assert.deepEqual(saved.emailTo, ['a@example.com'])
})
