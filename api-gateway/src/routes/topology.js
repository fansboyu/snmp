function isId(value) {
  return /^\d+$/.test(String(value ?? ''))
}

function isTruthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value)
    if (text) return text
  }
  return ''
}

function compareIds(left, right) {
  const a = BigInt(String(left ?? 0))
  const b = BigInt(String(right ?? 0))
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function orderedPair(left, right) {
  return compareIds(left, right) <= 0
    ? [String(left), String(right)]
    : [String(right), String(left)]
}

function nextPosition(index) {
  return {
    x: 80 + (index % 4) * 220,
    y: 80 + Math.floor(index / 4) * 140
  }
}

function positionKey(position) {
  return `${Math.round(Number(position.x))}:${Math.round(Number(position.y))}`
}

function nextAvailablePosition(occupiedPositions) {
  let index = 0
  for (;;) {
    const position = nextPosition(index)
    const key = positionKey(position)
    if (!occupiedPositions.has(key)) {
      occupiedPositions.add(key)
      return position
    }
    index += 1
  }
}

function neighborLinkKey(row) {
  const devicePair = orderedPair(row.device_id, row.remote_device_id).join(':')
  const localPort = firstNonEmpty(row.local_interface_name, row.local_port_descr, row.local_port_id, row.local_if_index)
  const remotePort = firstNonEmpty(row.remote_interface_name, row.remote_port_descr, row.remote_port_id)
  const localKey = firstNonEmpty(row.local_interface_id ? `if:${row.local_interface_id}` : '', `port:${localPort}`)
  const remoteKey = firstNonEmpty(row.remote_interface_id ? `if:${row.remote_interface_id}` : '', `port:${remotePort}`)
  const endpointPair = localKey < remoteKey ? [localKey, remoteKey] : [remoteKey, localKey]
  return [row.protocol, devicePair, ...endpointPair].join('|')
}

function buildAutoLinkLabel(row) {
  const localLabel = firstNonEmpty(row.local_interface_name, row.local_port_descr, row.local_port_id, row.local_if_index)
  const remoteLabel = firstNonEmpty(row.remote_interface_name, row.remote_port_descr, row.remote_port_id)
  const label = firstNonEmpty(
    localLabel && remoteLabel ? `${localLabel} ↔ ${remoteLabel}` : '',
    remoteLabel,
    row.remote_sys_name,
    row.remote_device_name
  )
  return label
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
  const [mapResult, nodesResult, linksResult] = await Promise.all([
    app.db.query(
      `
        select id, name, description, is_default, created_at, updated_at
        from topology_maps
        where id = $1
      `,
      [mapId]
    ),
    app.db.query(
      `
        select
          n.id,
          n.map_id,
          n.device_id,
          d.name as device_name,
          d.host as device_host,
          d.enabled as device_enabled,
          g.name as group_name,
          n.label,
          n.node_type,
          n.x,
          n.y,
          n.width,
          n.height,
          n.created_at,
          n.updated_at
        from topology_nodes n
        left join devices d on d.id = n.device_id
        left join device_groups g on g.id = d.group_id
        where n.map_id = $1
        order by n.id
      `,
      [mapId]
    ),
    app.db.query(
      `
        select
          l.id,
          l.map_id,
          l.source_node_id,
          l.target_node_id,
          l.source_interface_id,
          coalesce(si.if_name, si.if_descr, si.if_index::text) as source_interface_name,
          l.target_interface_id,
          coalesce(ti.if_name, ti.if_descr, ti.if_index::text) as target_interface_name,
          l.label,
          l.link_type,
          l.status,
          l.discovery_protocol,
          l.neighbor_id,
          l.auto_discovered,
          l.last_seen_at,
          l.created_at,
          l.updated_at
        from topology_links l
        left join device_interfaces si on si.id = l.source_interface_id
        left join device_interfaces ti on ti.id = l.target_interface_id
        where l.map_id = $1
        order by l.id
      `,
      [mapId]
    )
  ])

  return {
    map: mapResult.rows[0],
    nodes: nodesResult.rows,
    links: linksResult.rows
  }
}

async function listNeighbors(app, { unmatched = false } = {}) {
  const result = await app.db.query(
    `
      select
        n.id,
        n.device_id,
        d.name as device_name,
        host(d.host) as device_host,
        n.local_interface_id,
        coalesce(li.if_name, li.if_descr, n.local_port_descr, n.local_port_id, n.local_if_index::text) as local_interface_name,
        n.local_if_index,
        n.local_port_id,
        n.local_port_descr,
        n.protocol,
        n.remote_chassis_id,
        n.remote_device_name,
        n.remote_port_id,
        n.remote_port_descr,
        host(n.remote_mgmt_address) as remote_mgmt_address,
        n.remote_sys_name,
        n.remote_sys_descr,
        n.remote_device_id,
        rd.name as remote_device_name_matched,
        n.remote_interface_id,
        coalesce(ri.if_name, ri.if_descr, ri.if_alias, ri.if_index::text) as remote_interface_name,
        n.first_seen_at,
        n.last_seen_at,
        n.stale
      from device_neighbors n
      left join devices d on d.id = n.device_id
      left join device_interfaces li on li.id = n.local_interface_id
      left join devices rd on rd.id = n.remote_device_id
      left join device_interfaces ri on ri.id = n.remote_interface_id
      where ($1::boolean = false or n.remote_device_id is null)
      order by n.last_seen_at desc, n.id desc
    `,
    [unmatched]
  )
  return result.rows
}

async function syncAutoTopology(app, mapId) {
  const client = await app.db.connect()
  try {
    await client.query('begin')

    const neighborResult = await client.query(
      `
        select
          n.id,
          n.device_id,
          n.local_interface_id,
          coalesce(li.if_name, li.if_descr, n.local_port_descr, n.local_port_id, n.local_if_index::text) as local_interface_name,
          n.local_port_id,
          n.local_port_descr,
          n.protocol,
          n.remote_device_id,
          n.remote_interface_id,
          coalesce(ri.if_name, ri.if_descr, ri.if_alias, n.remote_port_descr, n.remote_port_id) as remote_interface_name,
          n.remote_port_id,
          n.remote_port_descr,
          n.remote_device_name,
          n.remote_sys_name,
          n.stale,
          n.last_seen_at
        from device_neighbors n
        left join device_interfaces li on li.id = n.local_interface_id
        left join device_interfaces ri on ri.id = n.remote_interface_id
        where n.remote_device_id is not null
        order by n.device_id, n.remote_device_id, n.id
      `
    )

    const deviceIds = new Set()
    for (const row of neighborResult.rows) {
      deviceIds.add(String(row.device_id))
      deviceIds.add(String(row.remote_device_id))
    }

    let createdNodes = 0
    if (deviceIds.size > 0) {
      const existingResult = await client.query(
        `
          select device_id
          from topology_nodes
          where map_id = $1
            and device_id = any($2::bigint[])
        `,
        [mapId, Array.from(deviceIds)]
      )
      const existing = new Set(existingResult.rows.map((row) => String(row.device_id)))
      const missing = Array.from(deviceIds).filter((id) => !existing.has(id))
      if (missing.length > 0) {
        const positionResult = await client.query(
          `
            select x, y
            from topology_nodes
            where map_id = $1
          `,
          [mapId]
        )
        const occupiedPositions = new Set(positionResult.rows.map(positionKey))
        const devices = await client.query(
          `
            select id, name
            from devices
            where id = any($1::bigint[])
            order by id
          `,
          [missing]
        )

        for (let index = 0; index < devices.rows.length; index++) {
          const position = nextAvailablePosition(occupiedPositions)
          const result = await client.query(
            `
              insert into topology_nodes (map_id, device_id, label, node_type, x, y, width, height)
              values ($1, $2, $3, 'device', $4, $5, 170, 64)
              on conflict (map_id, device_id) do nothing
            `,
            [mapId, devices.rows[index].id, devices.rows[index].name, position.x, position.y]
          )
          createdNodes += result.rowCount
        }
      }
    }

    const nodesResult = await client.query(
      `
        select id, device_id
        from topology_nodes
        where map_id = $1
          and device_id is not null
      `,
      [mapId]
    )
    const nodeByDeviceId = new Map(nodesResult.rows.map((row) => [String(row.device_id), row.id]))

    const staleResult = await client.query(
      `
        update topology_links l
        set status = case when n.stale then 'down' else 'up' end,
            discovery_protocol = n.protocol,
            auto_discovered = true,
            last_seen_at = n.last_seen_at,
            updated_at = now()
        from device_neighbors n
        where l.map_id = $1
          and l.neighbor_id = n.id
      `,
      [mapId]
    )

    const processedKeys = new Set()
    let upsertedLinks = 0

    for (const row of neighborResult.rows) {
      if (row.stale) continue

      const key = neighborLinkKey(row)
      if (processedKeys.has(key)) continue
      processedKeys.add(key)

      const sameDirection = compareIds(row.device_id, row.remote_device_id) <= 0
      const sourceDeviceId = sameDirection ? row.device_id : row.remote_device_id
      const targetDeviceId = sameDirection ? row.remote_device_id : row.device_id
      const sourceNodeId = nodeByDeviceId.get(String(sourceDeviceId))
      const targetNodeId = nodeByDeviceId.get(String(targetDeviceId))
      if (!sourceNodeId || !targetNodeId || String(sourceNodeId) === String(targetNodeId)) {
        continue
      }

      const sourceInterfaceId = sameDirection ? row.local_interface_id : row.remote_interface_id
      const targetInterfaceId = sameDirection ? row.remote_interface_id : row.local_interface_id
      const label = buildAutoLinkLabel(row)

      const result = await client.query(
        `
          insert into topology_links (
            map_id,
            source_node_id,
            target_node_id,
            source_interface_id,
            target_interface_id,
            label,
            link_type,
            status,
            discovery_protocol,
            neighbor_id,
            auto_discovered,
            last_seen_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, 'up', $7, $8, true, $9)
          on conflict (neighbor_id)
          do update set
            source_node_id = excluded.source_node_id,
            target_node_id = excluded.target_node_id,
            source_interface_id = excluded.source_interface_id,
            target_interface_id = excluded.target_interface_id,
            label = excluded.label,
            link_type = excluded.link_type,
            status = excluded.status,
            discovery_protocol = excluded.discovery_protocol,
            auto_discovered = true,
            last_seen_at = excluded.last_seen_at,
            updated_at = now()
        `,
        [
          mapId,
          sourceNodeId,
          targetNodeId,
          sourceInterfaceId ?? null,
          targetInterfaceId ?? null,
          label,
          row.protocol,
          row.id,
          row.last_seen_at
        ]
      )
      upsertedLinks += result.rowCount
    }

    await client.query('commit')
    return {
      created_nodes: createdNodes,
      updated_links: staleResult.rowCount + upsertedLinks,
      topology: await readTopology(app, mapId)
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function topologyRoutes(app) {
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
      height = 64
    } = request.body

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
      [map.id, device_id, label, node_type, x, y, width, height]
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
          x = coalesce($4, x),
          y = coalesce($5, y),
          width = coalesce($6, width),
          height = coalesce($7, height),
          updated_at = now()
        where id = $1
        returning id, map_id, device_id, label, node_type, x, y, width, height, created_at, updated_at
      `,
      [id, label, node_type, x, y, width, height]
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
      [id]
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
      status = 'unknown'
    } = request.body

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
      [map.id, source_node_id, target_node_id, source_interface_id, target_interface_id, label, link_type, status]
    )

    if (result.rowCount === 0) {
      reply.code(400)
      return { message: 'invalid topology link endpoints' }
    }

    reply.code(201)
    return result.rows[0]
  })

  app.patch('/links/:id', async (request, reply) => {
    const { id } = request.params
    if (!isId(id)) {
      reply.code(400)
      return { message: 'invalid topology link id' }
    }

    const { label, link_type, status, source_interface_id, target_interface_id } = request.body
    const result = await app.db.query(
      `
        update topology_links
        set
          label = coalesce($2, label),
          link_type = coalesce($3, link_type),
          status = coalesce($4, status),
          source_interface_id = coalesce($5, source_interface_id),
          target_interface_id = coalesce($6, target_interface_id),
          updated_at = now()
        where id = $1
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
      [id, label, link_type, status, source_interface_id, target_interface_id]
    )

    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'topology link not found' }
    }
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
        delete from topology_links
        where id = $1
        returning id
      `,
      [id]
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
              and map_id = $2
          `,
          [node.id, map.id, node.x, node.y, node.width ?? null, node.height ?? null]
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
