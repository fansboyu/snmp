export async function alertRoutes(app) {
  app.get('/summary', async () => {
    const result = await app.db.query(`
      select
        count(*) filter (where status = 'active')::integer as active_count,
        count(*) filter (where status = 'resolved')::integer as resolved_count,
        count(*) filter (where status = 'active' and severity = 'critical')::integer as critical_count,
        count(*) filter (where status = 'active' and severity = 'warning')::integer as warning_count
      from alert_events
    `)
    return result.rows[0]
  })

  app.get('/rules', async () => {
    const result = await app.db.query(`
      select
        r.id,
        r.name,
        r.rule_type,
        r.severity,
        r.device_id,
        d.name as device_name,
        r.interface_id,
        coalesce(i.if_name, i.if_descr, i.if_index::text) as interface_name,
        r.metric_name,
        r.operator,
        r.threshold,
        r.duration_seconds,
        r.enabled,
        r.created_at,
        r.updated_at
      from alert_rules r
      left join devices d on d.id = r.device_id
      left join device_interfaces i on i.id = r.interface_id
      order by r.id
    `)
    return result.rows
  })

  app.post('/rules', async (request, reply) => {
    const {
      name,
      rule_type,
      severity = 'warning',
      device_id = null,
      interface_id = null,
      metric_name = null,
      operator = null,
      threshold = null,
      duration_seconds = 0,
      enabled = true
    } = request.body
    const result = await app.db.query(
      `
        insert into alert_rules (
          name,
          rule_type,
          severity,
          device_id,
          interface_id,
          metric_name,
          operator,
          threshold,
          duration_seconds,
          enabled
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning *
      `,
      [name, rule_type, severity, device_id, interface_id, metric_name, operator, threshold, duration_seconds, enabled]
    )
    reply.code(201)
    return result.rows[0]
  })

  app.patch('/rules/:id', async (request) => {
    const { id } = request.params
    const {
      name,
      rule_type,
      severity,
      device_id,
      interface_id,
      metric_name,
      operator,
      threshold,
      duration_seconds,
      enabled
    } = request.body
    const result = await app.db.query(
      `
        update alert_rules
        set
          name = coalesce($2, name),
          rule_type = coalesce($3, rule_type),
          severity = coalesce($4, severity),
          device_id = coalesce($5, device_id),
          interface_id = coalesce($6, interface_id),
          metric_name = coalesce($7, metric_name),
          operator = coalesce($8, operator),
          threshold = coalesce($9, threshold),
          duration_seconds = coalesce($10, duration_seconds),
          enabled = coalesce($11, enabled),
          updated_at = now()
        where id = $1
        returning *
      `,
      [id, name, rule_type, severity, device_id, interface_id, metric_name, operator, threshold, duration_seconds, enabled]
    )
    return result.rows[0]
  })

  app.get('/events', async (request) => {
    const status = request.query.status
    const deviceId = request.query.deviceId
    const limit = Number(request.query.limit ?? 200)
    const result = await app.db.query(
      `
        select
          e.id,
          e.rule_id,
          r.name as rule_name,
          e.device_id,
          d.name as device_name,
          e.interface_id,
          coalesce(i.if_name, i.if_descr, i.if_index::text) as interface_name,
          e.severity,
          e.status,
          e.title,
          e.message,
          e.value_text,
          e.triggered_at,
          e.last_seen_at,
          e.resolved_at
        from alert_events e
        left join alert_rules r on r.id = e.rule_id
        left join devices d on d.id = e.device_id
        left join device_interfaces i on i.id = e.interface_id
        where ($1::text is null or e.status = $1)
          and ($2::bigint is null or e.device_id = $2)
        order by e.last_seen_at desc, e.triggered_at desc
        limit $3
      `,
      [status ?? null, deviceId ?? null, limit]
    )
    return result.rows
  })

  app.patch('/events/:id/resolve', async (request) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        update alert_events
        set status = 'resolved',
          resolved_at = coalesce(resolved_at, now()),
          last_seen_at = now()
        where id = $1 and status = 'active'
        returning *
      `,
      [id]
    )
    return result.rows[0]
  })
}
