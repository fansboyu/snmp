import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { topologyRoutes } from './routes/topology.js'
import { syncTopologyMonitor, readTopologyMonitor } from './topology-service.js'

test(
  'topology observation reconciliation, bindings, bundles, layout locks and history',
  { skip: !process.env.TOPOLOGY_TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.TOPOLOGY_TEST_DATABASE_URL })
    const app = Fastify()
    app.decorate('db', pool)
    await app.register(topologyRoutes, { prefix: '/api/topology' })
    await app.ready()
    const suffix = randomUUID(),
      deviceIds = []
    let map
    const query = (sql, args = []) => pool.query(sql, args)
    const call = async (method, url, payload, status = 200) => {
      const r = await app.inject({ method, url: '/api/topology' + url, payload })
      assert.equal(r.statusCode, status, r.body)
      return r.json()
    }
    try {
      map = (await call('GET', '/default')).map
      const addDevice = async (name, host) => {
        const d = (
          await query('insert into devices(name,host) values($1,$2) returning *', [name, host])
        ).rows[0]
        deviceIds.push(d.id)
        return d
      }
      const a = await addDevice('core-' + suffix, '192.0.2.210'),
        b = await addDevice('edge-' + suffix, '192.0.2.211')
      const queued = await call('POST', `/devices/${a.id}/scan`, undefined, 202)
      assert.equal(queued.status, 'pending')
      assert.equal(
        (await call('POST', `/devices/${a.id}/scan`, undefined, 202)).id,
        queued.id,
        'double clicks reuse active request',
      )
      const diagnostics = (await call('GET', '/default')).discovery
      assert.equal(diagnostics.devices.find((d) => d.id === a.id).status, 'pending')
      await query('update devices set enabled=false where id=$1', [b.id])
      await call('POST', `/devices/${b.id}/scan`, undefined, 400)
      await query('update devices set enabled=true where id=$1', [b.id])
      await query(
        "update topology_scan_requests set status='completed',finished_at=now() where id=$1",
        [queued.id],
      )
      await call('POST', `/devices/${a.id}/scan`, undefined, 429)
      const addPort = async (device, index) =>
        (
          await query(
            `insert into device_interfaces(device_id,if_index,if_name,oper_status,admin_status,speed_bps,last_seen_at)
    values($1,$2,$3,'1','1',1000000000,now()) returning *`,
            [device.id, index, 'GE1/0/' + index],
          )
        ).rows[0]
      const p1 = await addPort(a, 1),
        p2 = await addPort(b, 2),
        p3 = await addPort(a, 3),
        p4 = await addPort(b, 4)
      const addNeighbor = async (local, remote, lp, rp, protocol = 'lldp', name) =>
        (
          await query(
            `insert into device_neighbors(device_id,local_interface_id,local_port_id,remote_port_id,remote_device_name,remote_mgmt_address,protocol,fingerprint)
    values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
            [
              local.id,
              lp.id,
              lp.if_name,
              rp.if_name,
              name || remote.name,
              remote.host,
              protocol,
              suffix + randomUUID(),
            ],
          )
        ).rows[0]
      await addNeighbor(a, b, p1, p2)
      await addNeighbor(b, a, p2, p1)
      await addNeighbor(a, b, p1, p2, 'cdp')
      let synced = await syncTopologyMonitor(app, map.id)
      let ownLinks = synced.topology.links.filter((l) => l.evidence_ids?.length)
      assert.equal(ownLinks.length, 1, 'LLDP/CDP and both directions deduplicate')
      const first = ownLinks[0]
      assert.equal(first.evidence_count, 3)
      assert.equal(first.confirmation, 'bidirectional')
      assert.equal(first.status, 'up')
      await syncTopologyMonitor(app, map.id)
      assert.equal((await readTopologyMonitor(pool, map.id)).links.length, 1)
      await addNeighbor(a, b, p3, p4)
      synced = await syncTopologyMonitor(app, map.id)
      assert.equal(synced.topology.links.length, 2, 'real parallel links survive')
      const parallel = synced.topology.links.find((l) => l.id !== first.id)
      await query('update device_neighbors set stale=true where id=any($1::bigint[])', [
        first.evidence_ids,
      ])
      assert.equal(
        (await readTopologyMonitor(pool, map.id)).links.find((l) => l.id === first.id).status,
        'stale',
        'missing neighbor is not DOWN',
      )
      await query('update device_neighbors set stale=false where id=any($1::bigint[])', [
        first.evidence_ids,
      ])
      const wrongPort =
        String(first.source_node_id) ===
        String(synced.topology.nodes.find((n) => n.device_id === a.id).id)
          ? p2.id
          : p1.id
      await call('PATCH', `/links/${first.id}/settings`, { source_interface_id: wrongPort }, 400)
      const endpoint = await call('GET', `/links/${first.id}/detail`)
      assert.equal(endpoint.traffic.length, 2)
      assert.ok(endpoint.traffic[0].start)
      assert.ok(endpoint.traffic[0].end)
      const historyCount = Number(
        (await query('select count(*) from topology_changes where map_id=$1', [map.id])).rows[0]
          .count,
      )
      await syncTopologyMonitor(app, map.id)
      assert.equal(
        Number(
          (await query('select count(*) from topology_changes where map_id=$1', [map.id])).rows[0]
            .count,
        ),
        historyCount,
        'unchanged observations do not create audit noise',
      )
      await call('PATCH', `/links/${first.id}/settings`, {
        source_interface_id: null,
        label: '人工链路名称',
      })
      synced = await syncTopologyMonitor(app, map.id)
      assert.equal(
        synced.topology.links.find((l) => l.id === first.id).source_interface_id,
        null,
        'manual clear is not overwritten',
      )
      assert.equal(synced.topology.links.find((l) => l.id === first.id).label, '人工链路名称')
      const parent = await call(
        'POST',
        '/default/links',
        {
          source_node_id: first.source_node_id,
          target_node_id: first.target_node_id,
          label: 'LAG fixture',
        },
        201,
      )
      await call('PATCH', `/links/${first.id}/settings`, { bundle_id: parent.id })
      await call('PATCH', `/links/${parallel.id}/settings`, { bundle_id: parent.id })
      await call('PATCH', `/links/${parent.id}/settings`, { bundle_id: first.id }, 400)
      await call('PATCH', `/links/${parent.id}/settings`, { bundle_id: parent.id }, 400)
      assert.equal((await call('GET', `/links/${parent.id}/detail`)).members.length, 2)
      const node = synced.topology.nodes.find((n) => n.device_id === a.id)
      await call('PATCH', `/nodes/${node.id}/settings`, { position_locked: true, layer: 'core' })
      const saved = await call('PATCH', '/default/layout', {
        nodes: [{ id: node.id, x: 999, y: 999 }],
      })
      assert.equal(Number(saved.nodes.find((n) => n.id === node.id).x), Number(node.x))
      assert.equal(
        Number((await call('GET', '/default/layout-preview')).find((n) => n.id === node.id).x),
        Number(node.x),
      )
      await call(
        'PATCH',
        '/default/layout',
        { nodes: [{ id: node.id, x: 'not a number', y: 0 }] },
        400,
      )
      const unknown = await addNeighbor(a, { name: 'unknown-' + suffix, host: '192.0.2.212' }, p3, {
        if_name: 'GE1/0/4',
      })
      synced = await syncTopologyMonitor(app, map.id)
      assert.ok(
        synced.topology.nodes.some((n) => n.identity_key),
        'unknown neighbor is visible',
      )
      await call('PUT', `/neighbors/${unknown.id}/binding`, {
        remote_device_id: b.id,
        remote_interface_id: p4.id,
      })
      synced = await syncTopologyMonitor(app, map.id)
      assert.equal(
        synced.topology.nodes.filter((n) => n.identity_key).length,
        0,
        'confirmed identity removes orphan ghost',
      )
      assert.equal(
        synced.topology.links.filter((l) => l.auto_discovered).length,
        2,
        'manual matching merges evidence without duplicates',
      )
      const history = await call('GET', '/default/history')
      assert.ok(history.length > 0)
      const older = await call('GET', `/default/history?before=${history[history.length - 1].id}`)
      assert.ok(older.every((h) => BigInt(h.id) < BigInt(history[history.length - 1].id)))
      await call('DELETE', `/links/${parallel.id}`)
      synced = await syncTopologyMonitor(app, map.id)
      assert.ok(
        !synced.topology.links.some((l) => l.physical_key === parallel.physical_key),
        'deleted auto-link stays suppressed',
      )
      await call('POST', '/default/traffic', { link_ids: [first.id] })
      await call('POST', '/default/traffic', { link_ids: Array(101).fill(first.id) }, 400)
      await query('update devices set name=$2 where id=$1', [b.id, 'edge-' + suffix + '.customer'])
      const weak = await addNeighbor(a, { name: 'edge-' + suffix + '.other', host: null }, p1, p2)
      await query(
        `insert into topology_links(map_id,source_node_id,target_node_id,auto_discovered,evidence_ids) values($1,$2,$3,true,$4)`,
        [map.id, first.source_node_id, first.target_node_id, [weak.id]],
      )
      synced = await syncTopologyMonitor(app, map.id)
      assert.equal(
        synced.topology.neighbors.find((n) => n.id === weak.id).match_state,
        'needs_confirmation',
      )
      assert.ok(
        !synced.topology.links.some((l) => l.evidence_ids?.includes(weak.id)),
        'legacy weak guesses are removed, not displayed as confirmed links',
      )
    } finally {
      await app.close()
      // This suite runs only against its dedicated test database.
      if (map) {
        await query('delete from topology_maps where id=$1', [map.id])
      }
      await query('delete from devices where id=any($1::bigint[])', [deviceIds])
      await pool.end()
    }
  },
)
