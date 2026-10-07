import { emailTargets, loadMailConfig, publicMailConfig, updatedMailConfig, mailConfigSchema } from '../mail-config.js'

export async function alertRoutes(app) {
  app.get('/summary', async () => {
    const result = await app.db.query(`
      select
        count(*) filter (where status = 'active')::integer as active_count,
        count(*) filter (where status = 'resolved')::integer as resolved_count,
        count(*) filter (where status = 'active' and severity = 'critical')::integer as critical_count,
        count(*) filter (where status = 'active' and severity = 'warning')::integer as warning_count
      from alert_events
      where title <> '邮件通知测试'
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
    const interfaceId = request.query.interfaceId
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
          and e.title <> '邮件通知测试'
          and ($4::bigint is null or e.interface_id = $4)
        order by e.last_seen_at desc, e.triggered_at desc
        limit $3
      `,
      [status ?? null, deviceId ?? null, limit, interfaceId ?? null]
    )
    return result.rows
  })

  app.get('/notifications', async (request) => {
    const status = request.query.status
    const eventId = request.query.eventId
    const limit = Math.min(Number(request.query.limit ?? 200), 500)
    const result = await app.db.query(
      `
        select
          n.id,
          n.event_id,
          e.title as event_title,
          e.severity,
          e.status as event_status,
          d.name as device_name,
          n.channel,
          n.target,
          n.status,
          n.subject,
          n.message,
          n.error,
          n.retry_count,
          n.created_at,
          n.sent_at,
          n.updated_at
        from alert_notifications n
        join alert_events e on e.id = n.event_id
        left join devices d on d.id = e.device_id
        where ($1::text is null or n.status = $1)
          and ($2::bigint is null or n.event_id = $2)
        order by n.created_at desc
        limit $3
      `,
      [status ?? null, eventId ?? null, limit]
    )
    return result.rows
  })

  app.get('/notification-config', async () => {
    return publicMailConfig(await loadMailConfig(app))
  })

  app.patch('/notification-config', { schema: mailConfigSchema }, async (request, reply) => {
    const current = await loadMailConfig(app)
    let config
    try {
      config = updatedMailConfig(current, request.body, app.config.JWT_SECRET)
    } catch (error) {
      return reply.code(400).send({ message: error.message })
    }
    await app.db.query(`
      insert into email_notification_config (id, config) values (1, $1::jsonb)
      on conflict (id) do update set config = excluded.config, updated_at = now()
    `, [JSON.stringify(config)])
    return publicMailConfig({ ...config, source: 'database' })
  })

  app.post('/notifications/test-email', async (request, reply) => {
    const body = request.body ?? {}
    const config = await loadMailConfig(app)
    const targets = emailTargets(body.target || body.targets || config.emailTo)
    const smtpHost = config.smtpHost.trim()
    const smtpFrom = config.smtpFrom.trim()

    if (targets.length === 0) {
      reply.code(400)
      return { message: '请先在邮件配置中填写收件邮箱' }
    }
    if (targets.length > 100 || targets.some(target => !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(target))) {
      return reply.code(400).send({ message: '请输入有效的测试收件邮箱，最多 100 个' })
    }
    if (!smtpHost || !smtpFrom) {
      reply.code(400)
      return { message: '请先保存 SMTP 地址和发件邮箱' }
    }

    const subjectPrefix = config.subjectPrefix
    const subject = `${subjectPrefix} 邮件通知测试`
    const message = [
      '这是一封 SNMP Monitor 测试邮件。',
      '',
      `SMTP: ${smtpHost}:${config.smtpPort}`,
      `From: ${smtpFrom}`,
      `Time: ${new Date().toISOString()}`,
      '',
      '如果你收到这封邮件，说明通知队列和 notifier 容器已经可以正常处理邮件发送。'
    ].join('\n')

    const client = await app.db.connect()
    try {
      await client.query('begin')
      const event = await client.query(
        `
          insert into alert_events (
            severity,
            status,
            title,
            message,
            value_text,
            triggered_at,
            last_seen_at,
            resolved_at
          )
          values ('info', 'resolved', '邮件通知测试', $1, 'test', now(), now(), now())
          returning id, severity, status, title, message, value_text, triggered_at, last_seen_at, resolved_at
        `,
        [message]
      )

      const notifications = []
      for (const target of targets) {
        const notification = await client.query(
          `
            insert into alert_notifications (
              event_id,
              channel,
              target,
              status,
              subject,
              message,
              next_retry_at,
              updated_at
            )
            values ($1, 'email', $2, 'pending', $3, $4, now(), now())
            returning id, event_id, channel, target, status, subject, message, error, retry_count, created_at, sent_at, updated_at
          `,
          [event.rows[0].id, target, subject, message]
        )
        notifications.push(notification.rows[0])
      }
      await client.query('commit')
      reply.code(201)
      return { event: event.rows[0], notifications }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  })

  app.patch('/notifications/:id/retry', async (request, reply) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        update alert_notifications
        set status = 'pending',
          error = null,
          next_retry_at = now(),
          updated_at = now()
        where id = $1 and status = 'failed'
        returning *
      `,
      [id]
    )
    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'notification not found or not failed' }
    }
    return result.rows[0]
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
