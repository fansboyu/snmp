export async function metricRoutes(app) {
  app.get('/definitions', async () => {
    const result = await app.db.query(`
      select id, name, oid, unit, enabled
      from metric_definitions
      order by id
    `)
    return result.rows
  })

  app.get('/samples', async (request) => {
    const deviceId = request.query.deviceId
    const limit = Number(request.query.limit ?? 200)
    const result = await app.db.query(
      `
        select
          s.created_at,
          d.name as device_name,
          m.name as metric_name,
          m.unit,
          s.value_text
        from metric_samples s
        join devices d on d.id = s.device_id
        join metric_definitions m on m.id = s.metric_id
        where ($1::bigint is null or s.device_id = $1)
        order by s.created_at desc
        limit $2
      `,
      [deviceId ?? null, limit]
    )
    return result.rows
  })
}

