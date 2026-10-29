import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { databaseStartup } from './database-startup.js'
import { dbPlugin } from './plugins/db.js'

test('bootstrap retries only deadlocked transactions and has a bounded retry count', async () => {
  let attempts = 0
  const result = await databaseStartup(
    async () => {
      if (++attempts < 3) throw Object.assign(new Error('deadlock'), { code: '40P01' })
      return 'ready'
    },
    async () => {},
  )
  assert.equal(result, 'ready')
  assert.equal(attempts, 3)
  attempts = 0
  await assert.rejects(
    databaseStartup(
      async () => {
        attempts++
        throw Object.assign(new Error('deadlock'), { code: '40P01' })
      },
      async () => {},
    ),
  )
  assert.equal(attempts, 4)
  attempts = 0
  await assert.rejects(
    databaseStartup(
      async () => {
        attempts++
        throw Object.assign(new Error('credentials'), { code: '28P01' })
      },
      async () => {},
    ),
  )
  assert.equal(attempts, 1)
})
test(
  'concurrent API database initialization serializes shared runtime DDL',
  { skip: !process.env.TOPOLOGY_TEST_DATABASE_URL },
  async () => {
    const apps = Array.from({ length: 3 }, () => {
      const app = Fastify()
      app.decorate('config', { DATABASE_URL: process.env.TOPOLOGY_TEST_DATABASE_URL })
      app.register(dbPlugin)
      return app
    })
    try {
      await Promise.all(apps.map((app) => app.ready()))
      for (const app of apps)
        assert.equal((await app.db.query('select 1 as ready')).rows[0].ready, 1)
    } finally {
      await Promise.all(apps.map((app) => app.close()))
    }
  },
)
