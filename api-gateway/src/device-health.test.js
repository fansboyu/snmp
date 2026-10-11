import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { deviceRoutes } from './routes/devices.js'

test('device status uses fresh evidence, expires offline evidence and recovers on samples', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const ids = []
  let list
  await deviceRoutes({ db: pool, get: (path, handler) => { if (path === '/') list = handler }, post() {}, put() {}, patch() {}, delete() {} })
  const create = async (enabled = true, age = '7 minutes') => {
    const { rows } = await pool.query(`insert into devices(name,host,enabled,created_at,updated_at) values('API health test','192.0.2.254',$1,now()-$2::interval,now()-$2::interval) returning id`, [enabled, age])
    ids.push(rows[0].id)
    return rows[0].id
  }
  const status = async (id) => (await list()).find(row => row.id === id).online_status
  try {
    const id = await create()
    assert.equal(await status(id), 'unknown')
    await pool.query(`insert into device_health(device_id,status,checked_at,consecutive_failures,first_failed_at) values($1,'offline',now(),3,now()-interval '60 seconds')`, [id])
    assert.equal(await status(id), 'offline')
    await pool.query(`update device_health set checked_at=now()-interval '91 seconds' where device_id=$1`, [id])
    assert.equal(await status(id), 'unknown')
    await pool.query(`update device_health set checked_at=now(),status='collection_error',consecutive_failures=0 where device_id=$1`, [id])
    assert.equal(await status(id), 'collection_error')
    await pool.query(`insert into device_interfaces(device_id,if_index,last_seen_at) values($1,999,now())`, [id])
    assert.equal(await status(id), 'online')
    assert.equal(await status(await create(false)), 'disabled')
    assert.equal(await status(await create(true, '1 second')), 'pending')
    const changed = await create()
    await pool.query(`insert into device_health(device_id,status,checked_at) values($1,'offline',now()-interval '1 second')`, [changed])
    await pool.query(`update devices set updated_at=now() where id=$1`, [changed])
    assert.equal(await status(changed), 'unknown')
  } finally {
    await pool.query('delete from devices where id=any($1::bigint[])', [ids])
    await pool.end()
  }
})
