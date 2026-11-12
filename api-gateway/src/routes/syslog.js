const severityFilters = {
  critical: 'e.severity between 0 and 2',
  error: 'e.severity = 3',
  warning: 'e.severity = 4',
  info: 'e.severity between 5 and 7',
  unclassified: 'e.severity is null'
}

function asDate(value) {
  if (value === undefined || value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function paginationValue(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, maximum)
}

export async function syslogRoutes(app) {
  app.get('/status', async () => {
    const result = await app.db.query(`
      select
        coalesce(s.updated_at > now() - interval '30 seconds', false) as online,
        s.started_at,
        s.updated_at,
        s.last_received_at,
        coalesce(s.received_count, 0)::text as received_count,
        coalesce(s.stored_count, 0)::text as stored_count,
        coalesce(s.dropped_count, 0)::text as dropped_count,
        s.last_error,
        s.host_port,
        c.last_hour_count,
        c.critical_count,
        c.error_count,
        c.warning_count
      from (select 1) seed
      left join syslog_collector_status s on s.id = 1
      cross join lateral (
        select
          count(*)::integer as last_hour_count,
          count(*) filter (where severity between 0 and 2)::integer as critical_count,
          count(*) filter (where severity = 3)::integer as error_count,
          count(*) filter (where severity = 4)::integer as warning_count
        from syslog_events
        where received_at >= now() - interval '1 hour'
      ) c
    `)
    return result.rows[0]
  })

  app.get('/events', async (request, reply) => {
    const { q = '', deviceId, severity, start, end, range = '1h' } = request.query
    const query = String(q).trim()
    if (query.length > 200) return reply.code(400).send({ message: '搜索内容最多 200 个字符' })

    const deviceID = deviceId === undefined || deviceId === '' ? null : String(deviceId)
    if (deviceID !== null && !/^\d+$/.test(deviceID)) {
      return reply.code(400).send({ message: '无效设备 ID' })
    }
    const levelFilter = severity ? severityFilters[String(severity)] : null
    if (severity && !levelFilter) return reply.code(400).send({ message: '无效日志级别' })

    let from = asDate(start)
    let to = asDate(end)
    if ((start && !from) || (end && !to)) return reply.code(400).send({ message: '无效时间范围' })
    if (Boolean(start) !== Boolean(end)) return reply.code(400).send({ message: '开始和结束时间必须同时提供' })
    if (!from) {
      const windows = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }
      const hours = windows[String(range)]
      if (!hours) return reply.code(400).send({ message: '无效时间范围' })
      to = new Date()
      from = new Date(to.getTime() - hours * 60 * 60 * 1000)
    }
    if (to <= from || to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
      return reply.code(400).send({ message: '时间范围无效或超过 31 天' })
    }

    const page = paginationValue(request.query.page, 1, 1_000_000)
    const pageSize = paginationValue(request.query.pageSize, 50, 200)
    const offset = (page - 1) * pageSize
    const values = [from, to, deviceID, query || null, levelFilter ? severity : null, pageSize, offset]
    const commonWhere = `
      e.received_at >= $1 and e.received_at <= $2
      and ($3::bigint is null or e.device_id = $3)
      and ($4::text is null or e.search_vector @@ websearch_to_tsquery('simple', $4)
        or e.source_ip::text ilike '%' || $4 || '%' or d.name ilike '%' || $4 || '%')
      and ($5::text is null or ${levelFilter || 'true'})
    `
    const countResult = await app.db.query(`
      select count(*)::text as total
      from syslog_events e
      left join devices d on d.id = e.device_id
      where ${commonWhere}
    `, values.slice(0, 5))
    const rowsResult = await app.db.query(`
      select
        e.id::text,
        e.received_at,
        e.reported_at,
        e.source_ip::text as source_ip,
        e.hostname,
        e.device_id::text,
        d.name as device_name,
        e.facility,
        e.severity,
        e.app_name,
        e.procid,
        e.msgid,
        e.structured_data,
        e.syslog_version,
        e.parsed,
        e.message,
        e.raw_message
      from syslog_events e
      left join devices d on d.id = e.device_id
      where ${commonWhere}
      order by e.received_at desc, e.id desc
      limit $6 offset $7
    `, values)

    return {
      items: rowsResult.rows,
      total: Number(countResult.rows[0]?.total || 0),
      page,
      pageSize,
      start: from.toISOString(),
      end: to.toISOString()
    }
  })
}
