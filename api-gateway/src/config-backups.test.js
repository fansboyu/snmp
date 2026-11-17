import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import pg from 'pg'
import { configBackupRoutes, lineDiff } from './routes/config-backups.js'
import { decryptConfigCredential, encryptConfigBackup } from './config-backup-crypto.js'

test('configuration diff redacts secret values while retaining line context', () => {
  const diff = lineDiff('hostname edge\npassword cipher old-secret\n', 'hostname edge\npassword cipher new-secret\n')
  assert.equal(diff.available, true)
  assert.deepEqual(diff.removed, ['password <REDACTED>'])
  assert.deepEqual(diff.added, ['password <REDACTED>'])
  assert.equal(JSON.stringify(diff).includes('old-secret'), false)
  assert.equal(JSON.stringify(diff).includes('new-secret'), false)
})

test('large configurations do not allocate an unbounded line diff matrix', () => {
  const before = Array.from({ length: 1300 }, (_, index) => `before-${index}`).join('\n')
  const after = Array.from({ length: 1300 }, (_, index) => `after-${index}`).join('\n')
  assert.equal(lineDiff(before, after).available, false)
  assert.equal(lineDiff('\n'.repeat(1_300_000), 'x').available, false)
})

test('SSH profile saves ciphertext only and never returns credentials', async () => {
  const secret = 'unit-test-jwt-secret'
  let savedArgs
  const app = Fastify()
  app.decorate('config', { JWT_SECRET: secret })
  app.decorate('db', {
    async query(sql, args = []) {
      if (sql.includes('select credential_ciphertext,auth_mode')) return { rowCount: 0, rows: [] }
      if (sql.includes('select id from devices')) return { rowCount: 1, rows: [{ id: '7' }] }
      if (sql.includes('insert into device_config_backup_profiles')) {
        savedArgs = args
        return { rowCount: 1, rows: [{ device_id: '7', protocol: 'ssh', platform: 'h3c_comware', port: 22, username: 'backup', auth_mode: 'password', host_key_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', enabled: true, interval_hours: 24, retention_count: 30, credential_ciphertext: args[6] }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  })
  await app.register(configBackupRoutes, { prefix: '/api/config-backups' })
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/config-backups/devices/7/profile', payload: {
      protocol: 'ssh', platform: 'h3c_comware', port: 22, username: 'backup', password: 'sensitive-test-value',
      host_key_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', enabled: true, interval_hours: 24, retention_count: 30
    } })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json()
    assert.equal(body.credential_configured, true)
    assert.equal(Object.hasOwn(body, 'credential_ciphertext'), false)
    assert.equal(response.body.includes('sensitive-test-value'), false)
    assert.notEqual(savedArgs[6], 'sensitive-test-value')
    assert.deepEqual(decryptConfigCredential(savedArgs[6], secret), { password: 'sensitive-test-value', privateKey: '', privateKeyPassphrase: '' })
  } finally { await app.close() }
})

test('unverified SSH fingerprints and NETCONF configuration are rejected', async () => {
  const app = Fastify()
  app.decorate('config', { JWT_SECRET: 'test-secret' })
  app.decorate('db', { async query() { throw new Error('database should not be reached') } })
  await app.register(configBackupRoutes, { prefix: '/api/config-backups' })
  try {
    const base = { protocol: 'ssh', platform: 'cisco_ios', port: 22, username: 'backup', password: 'x', enabled: true }
    const noPin = await app.inject({ method: 'PUT', url: '/api/config-backups/devices/1/profile', payload: base })
    assert.equal(noPin.statusCode, 400)
    const netconf = await app.inject({ method: 'PUT', url: '/api/config-backups/devices/1/profile', payload: { ...base, protocol: 'netconf', host_key_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
    assert.equal(netconf.statusCode, 400)
  } finally { await app.close() }
})

test('download decrypts the raw configuration and records an audit event', async () => {
  const secret = 'download-test-jwt-secret'
  const content = Buffer.from('hostname edge-1\npassword cipher hidden-value\n')
  const encrypted = encryptConfigBackup(content, secret)
  const auditRows = []
  const app = Fastify()
  app.decorate('config', { JWT_SECRET: secret })
  app.addHook('preHandler', async (request) => { request.user = { username: 'operator' } })
  app.decorate('db', {
    async query(sql, args = []) {
      if (sql.includes('select v.id,v.device_id,v.created_at,v.encrypted_content,d.name')) return { rowCount: 1, rows: [{ id: args[0], device_id: '3', created_at: '2026-11-18T10:00:00Z', encrypted_content: encrypted, name: 'edge-1', host: '192.0.2.3' }] }
      if (sql.includes('insert into device_config_backup_audit')) { auditRows.push(args); return { rowCount: 1, rows: [] } }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  })
  await app.register(configBackupRoutes, { prefix: '/api/config-backups' })
  try {
    const response = await app.inject('/api/config-backups/versions/10/download')
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, content.toString())
    assert.equal(response.headers['cache-control'], 'no-store, private')
    assert.deepEqual(auditRows[0], ['3', '10', 'download', 'operator'])
  } finally { await app.close() }
})

test('configuration profile and manual task persist on migration 015 schema', {
  skip: !process.env.CONFIG_BACKUP_TEST_DATABASE_URL
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.CONFIG_BACKUP_TEST_DATABASE_URL })
  const device = (await pool.query("insert into devices(name,host) values('config-backup-test','192.0.2.250') returning id")).rows[0]
  const app = Fastify()
  app.decorate('config', { JWT_SECRET: 'integration-only-secret' })
  app.decorate('db', pool)
  await app.register(configBackupRoutes, { prefix: '/api/config-backups' })
  try {
    const payload = {
      protocol: 'ssh', platform: 'h3c_comware', port: 22, username: 'readonly', password: 'test-only-password',
      host_key_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', enabled: true, interval_hours: 24, retention_count: 3
    }
    const saved = await app.inject({ method: 'PUT', url: `/api/config-backups/devices/${device.id}/profile`, payload })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(saved.json().credential_configured, true)
    assert.equal(saved.body.includes('test-only-password'), false)
    const profile = await app.inject(`/api/config-backups/devices/${device.id}/profile`)
    assert.equal(profile.statusCode, 200, profile.body)
    assert.equal(profile.json().auth_mode, 'password')
    assert.equal(Object.hasOwn(profile.json(), 'credential_ciphertext'), false)
    const queued = await app.inject({ method: 'POST', url: `/api/config-backups/devices/${device.id}/run` })
    assert.equal(queued.statusCode, 202, queued.body)
    const duplicate = await app.inject({ method: 'POST', url: `/api/config-backups/devices/${device.id}/run` })
    assert.equal(duplicate.statusCode, 409)
    const overview = await app.inject('/api/config-backups')
    assert.equal(overview.statusCode, 200)
    assert.equal(overview.json().items.find((item) => item.device_id === String(device.id)).credential_configured, true)
  } finally {
    await app.close()
    await pool.query('delete from devices where id=$1', [device.id])
    await pool.end()
  }
})
