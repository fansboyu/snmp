import {
  resolveNeighbor,
  reconcileNeighborPorts,
  physicalIdentity,
  deriveLinkState,
} from './topology-model.js'
import { discoveryDiagnostics } from './topology-discovery.js'

export async function topologyInventory(db) {
  const tasks = [
    () =>
      db.query(`select d.id,d.name,host(d.host) as host,d.group_id,g.name as group_name,d.enabled,
      case when not d.enabled then 'disabled'
       when activity.last_seen_at>=now()-interval '6 minutes' then 'online'
       when h.checked_at>=now()-interval '90 seconds' and h.checked_at>=d.updated_at and h.checked_at>=coalesce(activity.last_seen_at,d.created_at) then h.status
       when activity.last_seen_at is null and d.created_at>=now()-interval '6 minutes' then 'pending' else 'unknown' end as online_status,
      activity.last_seen_at,h.reason as probe_reason
      from devices d left join device_groups g on g.id=d.group_id left join device_health h on h.device_id=d.id
      left join lateral (select greatest((select max(created_at) from metric_samples where device_id=d.id),
      (select max(created_at) from interface_metric_samples where device_id=d.id),
      (select max(last_seen_at) from device_interfaces where device_id=d.id)) as last_seen_at) activity on true`),
    () =>
      db.query(
        'select id,device_id,if_index,if_name,if_descr,if_alias,admin_status,oper_status,speed_bps,last_seen_at from device_interfaces',
      ),
    () => db.query("select * from topology_identities where updated_at>now()-interval '1 day'"),
    () => db.query('select * from device_neighbors order by id'),
    () => db.query('select * from topology_neighbor_bindings'),
    () =>
      db.query(
        'select s.*,d.name as device_name from topology_scans s join devices d on d.id=s.device_id order by s.device_id,s.protocol',
      ),
    () =>
      db.query(
        'select distinct on (device_id) * from topology_scan_requests order by device_id,id desc',
      ),
  ]
  const results = []
  if (typeof db.release === 'function') {
    for (const task of tasks) results.push(await task())
  } else results.push(...(await Promise.all(tasks.map((task) => task()))))
  const [devices, ports, identities, neighbors, bindings, scans, requests] = results
  const resolved = reconcileNeighborPorts(
    neighbors.rows.map((n) =>
      resolveNeighbor(
        n,
        devices.rows,
        ports.rows,
        identities.rows,
        bindings.rows.find((b) => String(b.neighbor_id) === String(n.id)),
      ),
    ),
    ports.rows,
  )
  return {
    devices: devices.rows,
    ports: ports.rows,
    identities: identities.rows,
    neighbors: resolved,
    scans: scans.rows,
    requests: requests.rows,
  }
}

export async function readTopologyMonitor(db, mapId) {
  const [inventory, map, nodes, links] = await Promise.all([
    topologyInventory(db),
    db.query('select * from topology_maps where id=$1', [mapId]),
    db.query('select * from topology_nodes where map_id=$1 order by id', [mapId]),
    db.query('select * from topology_links where map_id=$1 order by id', [mapId]),
  ])
  const enrichedNodes = nodes.rows.map((n) => {
    const device = inventory.devices.find((d) => String(d.id) === String(n.device_id))
    return {
      ...n,
      device_name: device?.name,
      device_host: device?.host,
      device_enabled: device?.enabled,
      group_name: device?.group_name,
      device_status: device?.online_status ?? 'unknown',
      last_sample_at: device?.last_seen_at,
      probe_reason: device?.probe_reason,
    }
  })
  const enrichedLinks = links.rows.map((l) => {
    const ids = l.evidence_ids?.length ? l.evidence_ids : [l.neighbor_id].filter(Boolean)
    const evidence = inventory.neighbors.filter((n) => ids.map(String).includes(String(n.id)))
    const endpoints = enrichedNodes.filter((n) =>
      [String(l.source_node_id), String(l.target_node_id)].includes(String(n.id)),
    )
    const state = deriveLinkState(l, inventory.ports, evidence, endpoints)
    const source = inventory.ports.find((p) => String(p.id) === String(l.source_interface_id))
    const target = inventory.ports.find((p) => String(p.id) === String(l.target_interface_id))
    return {
      ...l,
      configured_status: l.status,
      ...state,
      source_interface_name: source?.if_name || source?.if_descr,
      target_interface_name: target?.if_name || target?.if_descr,
      confirmation:
        evidence.length &&
        new Set(
          evidence
            .filter((n) => !n.stale && Date.now() - Date.parse(n.last_seen_at) < 1200000)
            .map((n) => String(n.device_id)),
        ).size > 1
          ? 'bidirectional'
          : evidence.length
            ? 'single'
            : 'manual',
      evidence_count: evidence.length,
    }
  })
  for (const parent of enrichedLinks) {
    const members = enrichedLinks.filter((l) => String(l.bundle_id) === String(parent.id))
    if (!members.length) continue
    parent.member_count = members.length
    parent.status = members.every((l) => l.status === 'up')
      ? 'up'
      : members.every((l) => ['down', 'disabled'].includes(l.status))
        ? 'down'
        : members.some((l) => l.status === 'down')
          ? 'degraded'
          : members.some((l) => l.status === 'stale')
            ? 'stale'
            : 'unconfirmed'
    parent.reason = `人工维护的聚合组：${members.filter((l) => l.status === 'up').length}/${members.length} 条成员正常；不推断 LACP 协商状态`
  }
  return {
    map: map.rows[0],
    nodes: enrichedNodes,
    links: enrichedLinks,
    scans: inventory.scans,
    neighbors: inventory.neighbors,
    devices: inventory.devices,
    ports: inventory.ports,
    discovery: discoveryDiagnostics(inventory, enrichedLinks),
  }
}

export async function syncTopologyMonitor(app, mapId) {
  const client = await app.db.connect()
  try {
    await client.query('begin')
    await client.query('select id from topology_maps where id=$1 for update', [mapId])
    const inventory = await topologyInventory(client)
    const nodeResult = await client.query(
      'select * from topology_nodes where map_id=$1 order by id',
      [mapId],
    )
    const existingLinks = await client.query(
      'select * from topology_links where map_id=$1 order by id',
      [mapId],
    )
    const suppressed = await client.query(
      'select physical_key from topology_suppressed_links where map_id=$1',
      [mapId],
    )
    const nodes = [...nodeResult.rows]
    const groups = new Map()
    let created = 0,
      updated = 0
    for (const row of inventory.neighbors) {
      if (
        row.stale ||
        Date.now() - Date.parse(row.last_seen_at) > 1200000 ||
        ['conflict', 'needs_confirmation'].includes(row.match_state)
      )
        continue
      const key = physicalIdentity(row)
      if (suppressed.rows.some((s) => s.physical_key === key)) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    const ensureNode = async (deviceId, identity, label) => {
      let node = nodes.find((n) =>
        deviceId ? String(n.device_id) === String(deviceId) : n.identity_key === identity,
      )
      if (node) return node
      let index = 0
      while (
        nodes.some(
          (n) =>
            Math.abs(Number(n.x) - (80 + (index % 4) * 240)) < 180 &&
            Math.abs(Number(n.y) - (80 + Math.floor(index / 4) * 150)) < 80,
        )
      )
        index++
      const inserted = await client.query(
        `insert into topology_nodes(map_id,device_id,label,node_type,x,y,width,height,identity_key,layer)
        values($1,$2,$3,$4,$5,$6,190,76,$7,$8) returning *`,
        [
          mapId,
          deviceId,
          label,
          deviceId ? 'device' : 'custom',
          80 + (index % 4) * 240,
          80 + Math.floor(index / 4) * 150,
          identity,
          deviceId ? 'access' : 'external',
        ],
      )
      node = inserted.rows[0]
      nodes.push(node)
      created++
      return node
    }
    const consumed = new Set()
    // Former short-name guesses must not survive as confirmed connections after
    // tightening identity matching. Keep manual bindings and other strong evidence.
    for (const link of existingLinks.rows) {
      const ids = link.evidence_ids?.length ? link.evidence_ids : [link.neighbor_id].filter(Boolean)
      const evidence = inventory.neighbors.filter((n) => ids.map(String).includes(String(n.id)))
      if (
        link.auto_discovered &&
        !link.binding_locked &&
        evidence.length &&
        evidence.every((n) => ['needs_confirmation', 'conflict'].includes(n.match_state))
      ) {
        await client.query('delete from topology_links where id=$1', [link.id])
        consumed.add(String(link.id))
      }
    }
    for (const [key, evidence] of groups) {
      const row = evidence[0]
      const localDevice = inventory.devices.find((d) => String(d.id) === String(row.device_id))
      const remoteDevice = inventory.devices.find(
        (d) => String(d.id) === String(row.remote_device_id),
      )
      if (!localDevice) continue
      let source = await ensureNode(localDevice.id, null, localDevice.name)
      let target = await ensureNode(
        remoteDevice?.id ?? null,
        remoteDevice
          ? null
          : `neighbor:${
              key
                .split('|')
                .find((v) => v.startsWith('unknown:'))
                ?.split('@')[0] ||
              row.remote_chassis_id ||
              row.remote_sys_name ||
              row.id
            }`,
        remoteDevice?.name ||
          `未知邻居 · ${row.remote_sys_name || row.remote_device_name || row.remote_chassis_id || '未识别'}`,
      )
      let sourcePort = row.local_interface_id,
        targetPort = row.remote_interface_id
      if (BigInt(source.id) > BigInt(target.id)) {
        ;[source, target] = [target, source]
        ;[sourcePort, targetPort] = [targetPort, sourcePort]
      }
      const ids = evidence.map((n) => String(n.id))
      const protocols = [...new Set(evidence.map((n) => n.protocol))].sort()
      const matched = existingLinks.rows.filter(
        (l) =>
          l.auto_discovered &&
          !consumed.has(String(l.id)) &&
          (l.physical_key === key ||
            ids.includes(String(l.neighbor_id)) ||
            l.evidence_ids?.some((id) => ids.includes(String(id)))),
      )
      const keep =
        matched.find((l) => l.physical_key === key) ||
        matched.find((l) => l.binding_locked) ||
        matched[0]
      for (const duplicate of matched.filter((l) => l !== keep && !l.binding_locked)) {
        await client.query('delete from topology_links where id=$1', [duplicate.id])
        consumed.add(String(duplicate.id))
      }
      const label = `${row.local_port_descr || row.local_port_id || '端口待确认'} ↔ ${row.remote_port_descr || row.remote_port_id || '端口待确认'}`
      if (keep) {
        consumed.add(String(keep.id))
        await client.query(
          `update topology_links set physical_key=$2,evidence_ids=$3,protocols=$4,neighbor_id=null,
          source_node_id=case when binding_locked then source_node_id else $5 end,target_node_id=case when binding_locked then target_node_id else $6 end,
          source_interface_id=case when binding_locked then source_interface_id else $7 end,target_interface_id=case when binding_locked then target_interface_id else $8 end,
          label=case when binding_locked then label else $9 end,last_seen_at=$10,updated_at=now() where id=$1`,
          [
            keep.id,
            key,
            ids,
            protocols,
            source.id,
            target.id,
            sourcePort,
            targetPort,
            label,
            evidence.reduce(
              (a, b) => (Date.parse(a) > Date.parse(b.last_seen_at) ? a : b.last_seen_at),
              evidence[0].last_seen_at,
            ),
          ],
        )
      } else {
        await client.query(
          `insert into topology_links(map_id,source_node_id,target_node_id,source_interface_id,target_interface_id,label,link_type,status,auto_discovered,physical_key,evidence_ids,protocols,last_seen_at)
          values($1,$2,$3,$4,$5,$6,$7,'unknown',true,$8,$9,$10,$11)`,
          [
            mapId,
            source.id,
            target.id,
            sourcePort,
            targetPort,
            label,
            protocols[0],
            key,
            ids,
            protocols,
            row.last_seen_at,
          ],
        )
      }
      updated++
    }
    await client.query(
      `delete from topology_nodes n where n.map_id=$1 and n.identity_key is not null and n.device_id is null and not n.position_locked
      and not exists(select 1 from topology_links where source_node_id=n.id or target_node_id=n.id)`,
      [mapId],
    )
    await client.query('commit')
    return {
      created_nodes: created,
      updated_links: updated,
      topology: await readTopologyMonitor(app.db, mapId),
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
