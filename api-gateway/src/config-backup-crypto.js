import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export function encryptConfigCredential(value, secret) {
  return encryptConfigBackup(Buffer.from(JSON.stringify(value), 'utf8'), secret)
}

export function encryptConfigBackup(value, secret) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce)
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptConfigCredential(encoded, secret) {
  return JSON.parse(decryptConfigBackup(encoded, secret).toString('utf8'))
}

export function decryptConfigBackup(encoded, secret) {
  const packed = Buffer.from(encoded, 'base64')
  if (packed.length < 29) throw new Error('配置凭据密文格式无效')
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(packed.length - 16))
  return Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()])
}
