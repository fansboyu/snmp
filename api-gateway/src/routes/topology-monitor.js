import { readTopologyMonitor, syncTopologyMonitor } from '../topology-service.js'
import { layoutTopology } from '../topology-model.js'
import { trafficWindow, loadTrafficRows, buildTraffic, downsample } from '../port-traffic.js'
import { topologyDiscoveryRoutes } from '../topology-discovery.js'

const id = (value) => /^\d+$/.test(String(value ?? ''))
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 })

export async function topologyMonitorRoutes(app, getMap) {
  await topologyDiscoveryRoutes(app)
  let timer,
    working = false,
    watermark = '',
    cleanupAt = 0
  const reconcile = async () => {
    if (working) return
    working = true
    try {
      const latest = await app.db.query(
        `select greatest((select max(updated_at) from device_neighbors),(select max(updated_at) from topology_neighbor_bindings)) as changed`,
      )
      const next = latest.rows[0].changed?.toISOString() || ''
      if (next && next !== watermark) {
        const map = await getMap(app)
        await syncTopologyMonitor(app, map.id)
        watermark = next
      }
      if (Date.now() - cleanupAt > 3600000) {
        await app.db.query(
          `delete from topology_changes where id in (select id from topology_changes where created_at<now()-interval '90 days' order by id limit 5000)`,
        )
        cleanupAt = Date.now()
      }
    } catch (error) {
      app.log?.warn({ err: error }, 'topology reconciliation failed')
    } finally {
      working = false
    }
  }
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      void reconcile()
    }, 30000)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    clearInterval(timer)
  })
  app.get('/default/history', async (request) => {
    const map = await getMap(app)
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50))
    const before = request.query.before
    if (before && !id(before)) throw invalid('无效历史游标')
    return (
      await app.db.query(
        'select * from topology_changes where map_id=$1 and ($2::bigint is null or id<$2) order by id desc limit $3',
        [map.id, before || null, Math.floor(limit)],
      )
    ).rows
  })
  app.get('/default/layout-preview', async () => {
    const map = await getMap(app)
    const data = await readTopologyMonitor(app.db, map.id)
    return layoutTopology(data.nodes, data.links)
  })
  app.patch('/nodes/:id/settings', async (request) => {
    const body = request.body || {}
    if (!id(request.params.id)) throw invalid('无效节点')
    if (body.layer && !['core', 'aggregation', 'access', 'external'].includes(body.layer))
      throw invalid('无效层级')
    if (body.position_locked !== undefined && typeof body.position_locked !== 'boolean')
      throw invalid('无效锁定设置')
    const result = await app.db.query(
      `update topology_nodes set layer=coalesce($2,layer),position_locked=coalesce($3,position_locked),
      label=coalesce($4,label),updated_at=now() where id=$1 returning *`,
      [request.params.id, body.layer, body.position_locked, body.label?.trim().slice(0, 200)],
    )
    if (!result.rowCount) throw Object.assign(new Error('节点不存在'), { statusCode: 404 })
    return result.rows[0]
  })
  app.put('/neighbors/:id/binding', async (request) => {
    const { remote_device_id, remote_interface_id } = request.body || {}
    if (
      !id(request.params.id) ||
      !id(remote_device_id) ||
      (remote_interface_id && !id(remote_interface_id))
    )
      throw invalid('请选择设备和有效端口')
    const client = await app.db.connect()
    try {
      await client.query('begin')
      const owned = await client.query(
        `select n.id from device_neighbors n join devices d on d.id=$2
        where n.id=$1 and n.device_id<>d.id and ($3::bigint is null or exists(select 1 from device_interfaces where id=$3 and device_id=d.id))`,
        [request.params.id, remote_device_id, remote_interface_id || null],
      )
      if (!owned.rowCount) throw invalid('邻居不存在、不能绑定自身，或端口不属于目标设备')
      await client.query(
        `insert into topology_neighbor_bindings(neighbor_id,remote_device_id,remote_interface_id) values($1,$2,$3)
        on conflict(neighbor_id) do update set remote_device_id=excluded.remote_device_id,remote_interface_id=excluded.remote_interface_id,updated_at=now()`,
        [request.params.id, remote_device_id, remote_interface_id || null],
      )
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    const map = await getMap(app)
    await app.db.query(
      `insert into topology_changes(map_id,entity_type,entity_id,action,after_data) values($1,'neighbor_binding',$2,'confirm',$3)`,
      [map.id, request.params.id, JSON.stringify({ remote_device_id, remote_interface_id })],
    )
    return syncTopologyMonitor(app, map.id)
  })
  app.delete('/neighbors/:id/binding', async (request) => {
    if (!id(request.params.id)) throw invalid('无效邻居')
    await app.db.query('delete from topology_neighbor_bindings where neighbor_id=$1', [
      request.params.id,
    ])
    const map = await getMap(app)
    return syncTopologyMonitor(app, map.id)
  })
  const updateLink = async (request) => {
    const body = request.body || {}
    if (!id(request.params.id)) throw invalid('无效链路')
    const client = await app.db.connect()
    try {
      await client.query('begin')
      const result = await client.query(
        `select l.*,s.device_id as source_device_id,t.device_id as target_device_id
        from topology_links l join topology_nodes s on s.id=l.source_node_id join topology_nodes t on t.id=l.target_node_id where l.id=$1 for update of l`,
        [request.params.id],
      )
      const link = result.rows[0]
      if (!link) throw Object.assign(new Error('链路不存在'), { statusCode: 404 })
      for (const side of ['source', 'target']) {
        const key = side + '_interface_id'
        if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
          if (!id(body[key])) throw invalid('无效端口')
          const port = await client.query(
            'select id from device_interfaces where id=$1 and device_id=$2',
            [body[key], link[side + '_device_id']],
          )
          if (!port.rowCount) throw invalid('端口不属于链路端点设备')
        }
      }
      if (body.bundle_id) {
        if (!id(body.bundle_id) || String(body.bundle_id) === String(link.id))
          throw invalid('无效聚合父链路')
        const bundle = await client.query(
          `select * from topology_links where id=$1 and map_id=$2 and bundle_id is null
          and ((source_node_id=$3 and target_node_id=$4) or (source_node_id=$4 and target_node_id=$3))`,
          [body.bundle_id, link.map_id, link.source_node_id, link.target_node_id],
        )
        const children = await client.query('select id from topology_links where bundle_id=$1', [
          link.id,
        ])
        if (!bundle.rowCount || children.rowCount)
          throw invalid('聚合仅支持相同设备对之间的一层成员关系，不能形成环')
      }
      const source =
        body.source_interface_id === undefined
          ? link.source_interface_id
          : body.source_interface_id || null
      const target =
        body.target_interface_id === undefined
          ? link.target_interface_id
          : body.target_interface_id || null
      const updated = await client.query(
        `update topology_links set source_interface_id=$2,target_interface_id=$3,
        label=$4,bundle_id=$5,binding_locked=true,updated_at=now() where id=$1 returning *`,
        [
          link.id,
          source,
          target,
          body.label === undefined ? link.label : String(body.label).slice(0, 200),
          body.bundle_id === undefined ? link.bundle_id : body.bundle_id || null,
        ],
      )
      await client.query('commit')
      return updated.rows[0]
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
  app.patch('/links/:id/settings', updateLink)
  app.patch('/links/:id', updateLink)
  app.get('/links/:id/detail', async (request) => {
    if (!id(request.params.id)) throw invalid('无效链路')
    const map = await getMap(app)
    const topology = await readTopologyMonitor(app.db, map.id)
    const link = topology.links.find((l) => String(l.id) === String(request.params.id))
    if (!link) throw Object.assign(new Error('链路不存在'), { statusCode: 404 })
    const ids = [link.source_interface_id, link.target_interface_id].filter(Boolean)
    const window = trafficWindow({ range: request.query.range || '1h' })
    const rows = await loadTrafficRows(app.db, ids, window)
    const ports = ids
      .map((id) => topology.ports.find((p) => String(p.id) === String(id)))
      .filter(Boolean)
    const traffic = ports.map((port) => {
      const result = buildTraffic(
        rows.filter((r) => String(r.interface_id) === String(port.id)),
        port,
        window,
      )
      return {
        port,
        ...result,
        points: downsample(result.points),
        start: new Date(window.start),
        end: new Date(window.end),
        resolution: '采样区间平均速率；超过 600 点按时长降采样',
      }
    })
    const nodes = topology.nodes.filter((n) =>
      [String(link.source_node_id), String(link.target_node_id)].includes(String(n.id)),
    )
    const deviceIds = nodes.map((n) => n.device_id).filter(Boolean)
    const alerts = await app.db.query(
      `select id,title,message,status,severity,device_id,interface_id,last_seen_at from alert_events
      where (interface_id=any($1::bigint[]) or (interface_id is null and device_id=any($2::bigint[]))) order by last_seen_at desc limit 40`,
      [ids, deviceIds],
    )
    const evidence = topology.neighbors.filter((n) =>
      (link.evidence_ids?.length ? link.evidence_ids : [link.neighbor_id])
        .map(String)
        .includes(String(n.id)),
    )
    return {
      link,
      nodes,
      traffic,
      alerts: alerts.rows,
      evidence,
      members: topology.links.filter((l) => String(l.bundle_id) === String(link.id)),
    }
  })
  app.post('/default/traffic', async (request) => {
    const map = await getMap(app)
    const wanted = request.body?.link_ids
    if (!Array.isArray(wanted) || wanted.length > 100 || wanted.some((v) => !id(v)))
      throw invalid('单次最多读取 100 条可见链路')
    const links = await app.db.query(
      'select * from topology_links where map_id=$1 and id=any($2::bigint[])',
      [map.id, wanted],
    )
    const ids = [
      ...new Set(
        links.rows.flatMap((l) => [l.source_interface_id, l.target_interface_id]).filter(Boolean),
      ),
    ]
    const ports = await app.db.query('select * from device_interfaces where id=any($1::bigint[])', [
      ids,
    ])
    const window = { start: Date.now() - 600000, end: Date.now() }
    const rows = await loadTrafficRows(app.db, ids, window)
    const summaries = new Map(
      ids.map((id) => [
        String(id),
        buildTraffic(
          rows.filter((r) => String(r.interface_id) === String(id)),
          ports.rows.find((p) => String(p.id) === String(id)) || {},
          window,
        ).summary,
      ]),
    )
    return links.rows.map((link) => ({
      id: link.id,
      source: summaries.get(String(link.source_interface_id)) ?? null,
      target: summaries.get(String(link.target_interface_id)) ?? null,
    }))
  })
}
