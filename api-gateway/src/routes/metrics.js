export async function metricRoutes(app) {
  app.get('/definitions', async () => {
    const result = await app.db.query(`
      select id, name, oid, unit, metric_kind, table_oid, enabled
      from metric_definitions
      order by id
    `)
    return result.rows
  })

  app.post('/definitions', async (request, reply) => {
    const { name, oid, unit = null, metric_kind = 'scalar', table_oid = null, enabled = true } = request.body
    const result = await app.db.query(
      `
        insert into metric_definitions (name, oid, unit, metric_kind, table_oid, enabled)
        values ($1, $2, $3, $4, $5, $6)
        returning id, name, oid, unit, metric_kind, table_oid, enabled
      `,
      [name, oid, unit, metric_kind, table_oid, enabled]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/definitions/:id', async (request) => {
    const { id } = request.params
    const { name, oid, unit, metric_kind, table_oid, enabled } = request.body
    const result = await app.db.query(
      `
        update metric_definitions
        set
          name = coalesce($2, name),
          oid = coalesce($3, oid),
          unit = coalesce($4, unit),
          metric_kind = coalesce($5, metric_kind),
          table_oid = coalesce($6, table_oid),
          enabled = coalesce($7, enabled)
        where id = $1
        returning id, name, oid, unit, metric_kind, table_oid, enabled
      `,
      [id, name, oid, unit, metric_kind, table_oid, enabled]
    )
    return result.rows[0]
  })

  app.get('/templates', async () => {
    const result = await app.db.query(`
      select
        t.id,
        t.name,
        t.description,
        t.enabled,
        count(td.metric_id)::integer as definition_count,
        t.created_at,
        t.updated_at
      from oid_templates t
      left join oid_template_definitions td on td.template_id = t.id
      group by t.id
      order by t.id
    `)
    return result.rows
  })

  app.post('/templates', async (request, reply) => {
    const { name, description = null, enabled = true } = request.body
    const result = await app.db.query(
      `
        insert into oid_templates (name, description, enabled)
        values ($1, $2, $3)
        returning id, name, description, enabled, created_at, updated_at
      `,
      [name, description, enabled]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/templates/:id', async (request) => {
    const { id } = request.params
    const { name, description, enabled } = request.body
    const result = await app.db.query(
      `
        update oid_templates
        set
          name = coalesce($2, name),
          description = coalesce($3, description),
          enabled = coalesce($4, enabled),
          updated_at = now()
        where id = $1
        returning id, name, description, enabled, created_at, updated_at
      `,
      [id, name, description, enabled]
    )
    return result.rows[0]
  })

  app.get('/templates/:id/definitions', async (request) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        select
          m.id,
          m.name,
          m.oid,
          m.unit,
          m.metric_kind,
          m.table_oid,
          m.enabled,
          td.sort_order
        from oid_template_definitions td
        join metric_definitions m on m.id = td.metric_id
        where td.template_id = $1
        order by td.sort_order, m.id
      `,
      [id]
    )
    return result.rows
  })

  app.post('/templates/:id/definitions', async (request, reply) => {
    const { id } = request.params
    const { metric_id, sort_order = 0 } = request.body
    const result = await app.db.query(
      `
        insert into oid_template_definitions (template_id, metric_id, sort_order)
        values ($1, $2, $3)
        on conflict (template_id, metric_id)
        do update set sort_order = excluded.sort_order
        returning template_id, metric_id, sort_order
      `,
      [id, metric_id, sort_order]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/templates/:id/definitions/:metricId', async (request) => {
    const { id, metricId } = request.params
    const { sort_order } = request.body
    const result = await app.db.query(
      `
        update oid_template_definitions
        set sort_order = coalesce($3, sort_order)
        where template_id = $1 and metric_id = $2
        returning template_id, metric_id, sort_order
      `,
      [id, metricId, sort_order]
    )
    return result.rows[0]
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
