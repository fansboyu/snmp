export async function interfaceRoutes(app) {
  app.get('/', async (request) => {
    const deviceId = request.query.deviceId
    const groupId = request.query.groupId
    const result = await app.db.query(
      `
        select
          i.id,
          i.device_id,
          d.name as device_name,
          d.group_id,
          g.name as group_name,
          i.if_index,
          i.if_descr,
          i.if_name,
          i.if_alias,
          i.oper_status,
          i.last_seen_at,
          i.updated_at
        from device_interfaces i
        join devices d on d.id = i.device_id
        left join device_groups g on g.id = d.group_id
        where ($1::bigint is null or i.device_id = $1)
          and ($2::bigint is null or d.group_id = $2)
        order by d.name, i.if_index
      `,
      [deviceId ?? null, groupId ?? null]
    )
    return result.rows
  })

  app.get('/samples', async (request) => {
    const deviceId = request.query.deviceId
    const interfaceId = request.query.interfaceId
    const metric = request.query.metric
    const limit = Number(request.query.limit ?? 200)
    const result = await app.db.query(
      `
        select
          s.created_at,
          s.device_id,
          d.name as device_name,
          s.interface_id,
          i.if_index,
          coalesce(i.if_name, i.if_descr, i.if_index::text) as interface_name,
          m.name as metric_name,
          m.unit,
          s.value_text
        from interface_metric_samples s
        join devices d on d.id = s.device_id
        join device_interfaces i on i.id = s.interface_id
        join metric_definitions m on m.id = s.metric_id
        where ($1::bigint is null or s.device_id = $1)
          and ($2::bigint is null or s.interface_id = $2)
          and ($3::text is null or m.name = $3)
        order by s.created_at desc
        limit $4
      `,
      [deviceId ?? null, interfaceId ?? null, metric ?? null, limit]
    )
    return result.rows
  })
}
