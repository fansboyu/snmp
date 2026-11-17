import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptConfigCredential, encryptConfigCredential } from './config-backup-crypto.js'

test('SSH credentials are authenticated encrypted JSON and reject a wrong key', () => {
  const credential = { password: 'test-only-password', privateKey: '', privateKeyPassphrase: '' }
  const encrypted = encryptConfigCredential(credential, 'test-only-jwt-secret')
  assert.notEqual(encrypted.includes(credential.password), true)
  assert.deepEqual(decryptConfigCredential(encrypted, 'test-only-jwt-secret'), credential)
  assert.throws(() => decryptConfigCredential(encrypted, 'wrong-key'))
})
