import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import pg from 'pg'
import { interfaceRoutes } from './routes/interfaces.js'

const connectionString = process.env.ENDPOINT_TEST_DATABASE_URL

test('port endpoint API correlates MAC and IPv4 observations with explicit confidence', {
  skip: !connectionString,
}, async () => {
  const admin = new pg.Pool({ connectionString })
  const schema = `endpoint_test_${randomUUID().replaceAll('-', '')}`
  let pool
  let app
  try {
    await admin.query(`create schema ${schema}`)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    await pool.query(`
      create table devices (id bigint primary key, name text, host text, group_id bigint);
      create table device_groups (id bigint primary key, name text);
      create table device_interfaces (
        id bigint primary key, device_id bigint, if_index integer, if_name text, if_descr text,
        admin_status text, oper_status text
      );
      create table switch_mac_observations (
        device_id bigint, vlan_id integer, mac_address text, if_index integer,
        active boolean, observed_at timestamptz
      );
      create table ip_mac_observations (
        device_id bigint, vlan_id integer, if_index integer, ip_address inet, mac_address text,
        active boolean, observed_at timestamptz
      );
      create table topology_scans (
        device_id bigint, protocol text, status text, reason text, checked_at timestamptz,
        last_success_at timestamptz, neighbor_count integer
      );
      create table device_neighbors (device_id bigint, local_if_index integer, stale boolean, last_seen_at timestamptz);
      insert into devices values (1,'Switch','192.0.2.10',null),(2,'Gateway A','192.0.2.1',null),(3,'Gateway B','192.0.2.2',null);
      insert into device_interfaces values (100,1,7,'Gi1/0/7','Gi1/0/7','1','1');
      insert into switch_mac_observations values
        (1,10,'02:00:00:00:00:01',7,true,now()),
        (1,20,'02:00:00:00:00:01',7,true,now()),
        (1,10,'02:00:00:00:00:02',7,true,now()),
        (1,10,'02:00:00:00:00:02',8,true,now()),
        (1,0,'02:00:00:00:00:03',7,true,now()),
        (1,0,'02:00:00:00:00:04',7,true,now()),
        (1,0,'02:00:00:00:00:05',7,true,now());
      insert into ip_mac_observations values
        (2,10,5,'192.0.2.101','02:00:00:00:00:01',true,now()),
        (2,10,5,'192.0.2.102','02:00:00:00:00:02',true,now()),
        (2,0,5,'192.0.2.103','02:00:00:00:00:03',true,now()),
        (2,0,7,'192.0.2.103','02:00:00:00:00:03',true,now()),
        (3,0,6,'192.0.2.103','02:00:00:00:00:03',true,now()),
        (2,0,5,'192.0.2.105','02:00:00:00:00:05',true,now());
      insert into topology_scans values (1,'qbridge_fdb','success','FDB read',now(),now(),7);
    `)

    app = Fastify()
    app.decorate('db', pool)
    await app.register(interfaceRoutes, { prefix: '/api/interfaces' })
    const response = await app.inject('/api/interfaces/100/endpoints?deviceId=1')
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json()
    assert.equal(result.items.length, 8)
    const find = (mac, vlan) => result.items.find((item) => item.mac_address === mac && item.vlan_id === vlan)
    assert.equal(find('02:00:00:00:00:01', 10).confidence, 'high')
    assert.equal(find('02:00:00:00:00:01', 10).mac_location_count, 1)
    assert.equal(find('02:00:00:00:00:01', 20).confidence, 'mac_only')
    assert.equal(find('02:00:00:00:00:02', 10).confidence, 'ambiguous')
    assert.equal(find('02:00:00:00:00:03', null).confidence, 'ambiguous')
    assert.equal(find('02:00:00:00:00:03', null).ip_source_count, 3)
    assert.equal(find('02:00:00:00:00:04', null).confidence, 'mac_only')
    assert.equal(find('02:00:00:00:00:05', null).confidence, 'medium')
  } finally {
    if (app) await app.close()
    if (pool) await pool.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
