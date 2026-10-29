import { readTopologyMonitor, topologyInventory, syncTopologyMonitor } from '../topology-service.js'
import { topologyMonitorRoutes } from './topology-monitor.js'
function isId(value) {
  return /^\d+$/.test(String(value ?? ''))
}

function isTruthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1
}

async function getDefaultMap(app) {
  const result = await app.db.query(`
    with selected as (
      select id, name, description, is_default, created_at, updated_at
      from topology_maps
      where is_default = true
      order by id
      limit 1
    ),
    inserted as (
      insert into topology_maps (name, description, is_default)
      select '默认拓扑', '手动维护和自动同步的默认网络拓扑', true
      where not exists (select 1 from selected)
      on conflict (name) do update
        set is_default = true,
            updated_at = now()
      returning id, name, description, is_default, created_at, updated_at
    )
    select id, name, description, is_default, created_at, updated_at from inserted
    union all
    select id, name, description, is_default, created_at, updated_at from selected
    limit 1
  `)
  return result.rows[0]
}

async function readTopology(app, mapId) {
  return readTopologyMonitor(app.db, mapId)
}

async function listNeighbors(app, { unmatched = false } = {}) {
  const data = await topologyInventory(app.db)
  return data.neighbors.filter((n) => !unmatched || n.match_state !== 'matched')
}

async function syncAutoTopology(app, mapId) {
  return syncTopologyMonitor(app, mapId)
}

export async function topologyRoutes(app) {
  await topologyMonitorRoutes(app, getDefaultMap)
  app.get('/default', async () => {
    const map = await getDefaultMap(app)
    return readTopology(app, map.id)
  })

  app.get('/neighbors', async (request) => {
    return listNeighbors(app, { unmatched: isTruthy(request.query.unmatched) })
  })

  app.post('/default/auto-sync', async () => {
    const map = await getDefaultMap(app)
    return syncAutoTopology(app, map.id)
  })

  app.post('/default/nodes', async (request, reply) => {
    const map = await getDefaultMap(app)
    const {
      device_id = null,
      label,
      node_type = 'device',
      x = 80,
      y = 80,
      width = 170,
      height = 64,
    } = request.body
    if (
      !String(label || '').trim() ||
      String(label).length > 200 ||
      (device_id && !isId(device_id)) ||
      !['device', 'network', 'custom'].includes(node_type)
    ) {
      reply.code(400)
      return { message: '节点名称、类型或设备 ID 无效' }
    }

    const result = await app.db.query(
      `
        insert into topology_nodes (map_id, device_id, label, node_type, x, y, width, height)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (map_id, device_id)
        do update set
          label = excluded.label,
          node_type = excluded.node_type,
          x = excluded.x,
          y = excluded.y,
          width = excluded.width,
          height = excluded.height,
          updated_at = now()
        returning id, map_id, device_id, label, node_type, x, y, width, height, created_at, updated_at
      `,
      [map.id, device_id, label, node_type, x, y, width, height],
    )

    reply.code(201)
    return result.rows[0]
  })

  app.patch('/nodes/:id', async (request, reply) => {
    const { id } = request.params
    if (!isId(id)) {
      reply.code(400)
      return { message: 'invalid topology node id' }
    }

    const { label, node_type, x, y, width, height } = request.body
    const result = await app.db.query(
      `
        update topology_nodes
        set
          label = coalesce($2, label),
          node_type = coalesce($3, node_type),
          x = case when position_locked then x else coalesce($4, x) end,
          y = case when position_locked then y else coalesce($5, y) end,
          width = coalesce($6, width),
          height = coalesce($7, height),
          updated_at = now()
        where id = $1
        returning id, map_id, device_id, label, node_type, x, y, width, height, created_at, updated_at
      `,
      [id, label, node_type, x, y, width, height],
    )

    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'topology node not found' }
    }
    return result.rows[0]
  })

  app.delete('/nodes/:id', async (request, reply) => {
    const { id } = request.params
    if (!isId(id)) {
      reply.code(400)
      return { message: 'invalid topology node id' }
    }

    const result = await app.db.query(
      `
        delete from topology_nodes
        where id = $1
        returning id
      `,
      [id],
    )

    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'topology node not found' }
    }
    return result.rows[0]
  })

  app.post('/default/links', async (request, reply) => {
    const map = await getDefaultMap(app)
    const {
      source_node_id,
      target_node_id,
      source_interface_id = null,
      target_interface_id = null,
      label = null,
      link_type = 'manual',
      status = 'unknown',
    } = request.body
    if (
      !isId(source_node_id) ||
      !isId(target_node_id) ||
      [source_interface_id, target_interface_id].some((v) => v && !isId(v))
    ) {
      reply.code(400)
      return { message: '无效链路或端口 ID' }
    }

    const result = await app.db.query(
      `
        insert into topology_links (
          map_id,
          source_node_id,
          target_node_id,
          source_interface_id,
          target_interface_id,
          label,
          link_type,
          status
        )
        select $1, $2, $3, $4, $5, nullif($6, ''), $7, $8
        where exists (select 1 from topology_nodes where id = $2 and map_id = $1)
          and exists (select 1 from topology_nodes where id = $3 and map_id = $1)
          and $2 <> $3
          and ($4::bigint is null or exists(select 1 from device_interfaces i join topology_nodes n on n.device_id=i.device_id where i.id=$4 and n.id=$2))
          and ($5::bigint is null or exists(select 1 from device_interfaces i join topology_nodes n on n.device_id=i.device_id where i.id=$5 and n.id=$3))
        returning
          id,
          map_id,
          source_node_id,
          target_node_id,
          source_interface_id,
          target_interface_id,
          label,
          link_type,
          status,
          created_at,
          updated_at
      `,
      [
        map.id,
        source_node_id,
        target_node_id,
        source_interface_id,
        target_interface_id,
        label,
        link_type,
        status,
      ],
    )

    if (result.rowCount === 0) {
      reply.code(400)
      return { message: 'invalid topology link endpoints' }
    }

    reply.code(201)
    return result.rows[0]
  })

  app.delete('/links/:id', async (request, reply) => {
    const { id } = request.params
    if (!isId(id)) {
      reply.code(400)
      return { message: 'invalid topology link id' }
    }

    const result = await app.db.query(
      `
        with suppressed as (
          insert into topology_suppressed_links(map_id,physical_key)
          select map_id,physical_key from topology_links where id = $1 and physical_key is not null
          on conflict do nothing
        ) delete from topology_links
        where id = $1
        returning id
      `,
      [id],
    )

    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'topology link not found' }
    }
    return result.rows[0]
  })

  app.patch('/default/layout', async (request) => {
    const map = await getDefaultMap(app)
    const nodes = Array.isArray(request.body.nodes) ? request.body.nodes : []
    if (
      nodes.length > 2000 ||
      nodes.some(
        (n) =>
          !isId(n.id) ||
          ![n.x, n.y].every(
            (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000,
          ) ||
          [n.width, n.height].some(
            (v) =>
              v !== undefined &&
              (typeof v !== 'number' || !Number.isFinite(v) || v < 30 || v > 2000),
          ),
      )
    ) {
      throw Object.assign(new Error('布局参数无效'), { statusCode: 400 })
    }
    const client = await app.db.connect()

    try {
      await client.query('begin')
      for (const node of nodes) {
        await client.query(
          `
            update topology_nodes
            set x = $3,
                y = $4,
                width = coalesce($5, width),
                height = coalesce($6, height),
                updated_at = now()
            where id = $1
              and map_id = $2 and not position_locked
          `,
          [node.id, map.id, node.x, node.y, node.width ?? null, node.height ?? null],
        )
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }

    return readTopology(app, map.id)
  })
}
