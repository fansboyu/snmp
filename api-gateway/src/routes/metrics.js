export async function metricRoutes(app) {
  app.get('/definitions', async () => {
    const result = await app.db.query(`
      select
        id,
        name,
        oid,
        unit,
        coalesce(display_name, name) as display_name,
        description,
        metric_kind,
        table_oid,
        value_type,
        scale,
        precision,
        aggregate_method,
        display_group,
        vendor,
        chartable,
        alertable,
        enabled
      from metric_definitions
      order by id
    `)
    return result.rows
  })

  app.post('/definitions', async (request, reply) => {
    const {
      name,
      oid,
      unit = null,
      display_name = null,
      description = null,
      metric_kind = 'scalar',
      table_oid = null,
      value_type = 'gauge',
      scale = 1,
      precision = 2,
      aggregate_method = 'latest',
      display_group = null,
      vendor = null,
      chartable = true,
      alertable = false,
      enabled = true
    } = request.body
    const result = await app.db.query(
      `
        insert into metric_definitions (
          name, oid, unit, display_name, description, metric_kind, table_oid, value_type, scale, precision,
          aggregate_method, display_group, vendor, chartable, alertable, enabled
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        returning id, name, oid, unit, coalesce(display_name, name) as display_name, description, metric_kind, table_oid, value_type, scale, precision, aggregate_method, display_group, vendor, chartable, alertable, enabled
      `,
      [
        name,
        oid,
        unit,
        display_name,
        description,
        metric_kind,
        table_oid,
        value_type,
        scale,
        precision,
        aggregate_method,
        display_group,
        vendor,
        chartable,
        alertable,
        enabled
      ]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/definitions/:id', async (request) => {
    const { id } = request.params
    const {
      name,
      oid,
      unit,
      display_name,
      description,
      metric_kind,
      table_oid,
      value_type,
      scale,
      precision,
      aggregate_method,
      display_group,
      vendor,
      chartable,
      alertable,
      enabled
    } = request.body
    const result = await app.db.query(
      `
        update metric_definitions
        set
          name = coalesce($2, name),
          oid = coalesce($3, oid),
          unit = coalesce($4, unit),
          display_name = coalesce($5, display_name),
          description = coalesce($6, description),
          metric_kind = coalesce($7, metric_kind),
          table_oid = coalesce($8, table_oid),
          value_type = coalesce($9, value_type),
          scale = coalesce($10, scale),
          precision = coalesce($11, precision),
          aggregate_method = coalesce($12, aggregate_method),
          display_group = coalesce($13, display_group),
          vendor = coalesce($14, vendor),
          chartable = coalesce($15, chartable),
          alertable = coalesce($16, alertable),
          enabled = coalesce($17, enabled)
        where id = $1
        returning id, name, oid, unit, coalesce(display_name, name) as display_name, description, metric_kind, table_oid, value_type, scale, precision, aggregate_method, display_group, vendor, chartable, alertable, enabled
      `,
      [
        id,
        name,
        oid,
        unit,
        display_name,
        description,
        metric_kind,
        table_oid,
        value_type,
        scale,
        precision,
        aggregate_method,
        display_group,
        vendor,
        chartable,
        alertable,
        enabled
      ]
    )
    return result.rows[0]
  })

  app.get('/templates', async () => {
    const result = await app.db.query(`
      select
        t.id,
        t.name,
        t.description,
        t.vendor,
        t.device_type,
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
    const { name, description = null, vendor = null, device_type = null, enabled = true } = request.body
    const result = await app.db.query(
      `
        insert into oid_templates (name, description, vendor, device_type, enabled)
        values ($1, $2, $3, $4, $5)
        returning id, name, description, vendor, device_type, enabled, created_at, updated_at
      `,
      [name, description, vendor, device_type, enabled]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/templates/:id', async (request) => {
    const { id } = request.params
    const { name, description, vendor, device_type, enabled } = request.body
    const result = await app.db.query(
      `
        update oid_templates
        set
          name = coalesce($2, name),
          description = coalesce($3, description),
          vendor = coalesce($4, vendor),
          device_type = coalesce($5, device_type),
          enabled = coalesce($6, enabled),
          updated_at = now()
        where id = $1
        returning id, name, description, vendor, device_type, enabled, created_at, updated_at
      `,
      [id, name, description, vendor, device_type, enabled]
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
          coalesce(m.display_name, m.name) as display_name,
          m.description,
          m.metric_kind,
          m.table_oid,
          m.value_type,
          m.scale,
          m.precision,
          m.aggregate_method,
          m.display_group,
          m.vendor,
          m.chartable,
          m.alertable,
          m.enabled,
          td.sort_order,
          td.enabled as binding_enabled,
          td.required
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
    const { metric_id, sort_order = 0, enabled = true, required = false } = request.body
    const result = await app.db.query(
      `
        insert into oid_template_definitions (template_id, metric_id, sort_order, enabled, required)
        values ($1, $2, $3, $4, $5)
        on conflict (template_id, metric_id)
        do update set
          sort_order = excluded.sort_order,
          enabled = excluded.enabled,
          required = excluded.required
        returning template_id, metric_id, sort_order, enabled as binding_enabled, required
      `,
      [id, metric_id, sort_order, enabled, required]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/templates/:id/definitions/:metricId', async (request) => {
    const { id, metricId } = request.params
    const { sort_order, enabled, required } = request.body
    const result = await app.db.query(
      `
        update oid_template_definitions
        set
          sort_order = coalesce($3, sort_order),
          enabled = coalesce($4, enabled),
          required = coalesce($5, required)
        where template_id = $1 and metric_id = $2
        returning template_id, metric_id, sort_order, enabled as binding_enabled, required
      `,
      [id, metricId, sort_order, enabled, required]
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
