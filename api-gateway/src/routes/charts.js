const rangeMap = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours'
}

function rangeInterval(range) {
  return rangeMap[range] ?? rangeMap['1h']
}

export async function chartRoutes(app) {
  app.get('/cpu', async (request) => {
    const deviceId = request.query.deviceId
    const interval = rangeInterval(request.query.range)
    const result = await app.db.query(
      `
        select
          date_trunc('minute', s.created_at) as time,
          avg(nullif(regexp_replace(s.value_text, '[^0-9.]+', '', 'g'), '')::numeric) as value
        from metric_samples s
        join metric_definitions m on m.id = s.metric_id
        where s.created_at >= now() - $2::interval
          and ($1::bigint is null or s.device_id = $1)
          and (m.display_group = 'cpu' or m.name ilike '%cpu%' or m.name = 'hrProcessorLoad')
        group by 1
        order by 1
      `,
      [deviceId ?? null, interval]
    )
    return result.rows.map((row) => ({
      time: row.time,
      value: row.value === null ? null : Number(row.value)
    }))
  })

  app.get('/memory', async (request) => {
    const deviceId = request.query.deviceId
    const interval = rangeInterval(request.query.range)
    const result = await app.db.query(
      `
        select
          date_trunc('minute', s.created_at) as time,
          avg(nullif(regexp_replace(s.value_text, '[^0-9.]+', '', 'g'), '')::numeric) as value
        from metric_samples s
        join metric_definitions m on m.id = s.metric_id
        where s.created_at >= now() - $2::interval
          and ($1::bigint is null or s.device_id = $1)
          and (m.display_group = 'memory' or m.name ilike '%mem%' or m.name ilike '%memory%')
        group by 1
        order by 1
      `,
      [deviceId ?? null, interval]
    )
    return result.rows.map((row) => ({
      time: row.time,
      value: row.value === null ? null : Number(row.value)
    }))
  })

  app.get('/interface-traffic', async (request) => {
    const deviceId = request.query.deviceId
    const interfaceId = request.query.interfaceId
    const interval = rangeInterval(request.query.range)
    const result = await app.db.query(
      `
        with ordered as (
          select
            s.created_at,
            s.interface_id,
            m.name as metric_name,
            nullif(regexp_replace(s.value_text, '[^0-9]+', '', 'g'), '')::numeric as value,
            lag(nullif(regexp_replace(s.value_text, '[^0-9]+', '', 'g'), '')::numeric)
              over (partition by s.interface_id, m.name order by s.created_at) as previous_value,
            lag(s.created_at)
              over (partition by s.interface_id, m.name order by s.created_at) as previous_time
          from interface_metric_samples s
          join metric_definitions m on m.id = s.metric_id
          where s.created_at >= now() - $3::interval
            and ($1::bigint is null or s.device_id = $1)
            and ($2::bigint is null or s.interface_id = $2)
            and m.name in ('ifInOctets', 'ifOutOctets')
        )
        select
          created_at as time,
          metric_name,
          greatest(((value - previous_value) * 8) / nullif(extract(epoch from created_at - previous_time), 0), 0) as bps
        from ordered
        where previous_value is not null and value >= previous_value
        order by created_at
      `,
      [deviceId ?? null, interfaceId ?? null, interval]
    )

    const buckets = new Map()
    for (const row of result.rows) {
      const key = new Date(row.time).toISOString()
      const point = buckets.get(key) ?? { time: row.time, in_bps: 0, out_bps: 0 }
      if (row.metric_name === 'ifInOctets') point.in_bps += Number(row.bps)
      if (row.metric_name === 'ifOutOctets') point.out_bps += Number(row.bps)
      buckets.set(key, point)
    }
    return Array.from(buckets.values())
  })

  app.get('/interface-status', async (request) => {
    const deviceId = request.query.deviceId
    const result = await app.db.query(
      `
        select
          case
            when oper_status in ('1', 'up') then 'up'
            when oper_status in ('2', 'down') then 'down'
            else 'unknown'
          end as status,
          count(*)::integer as count
        from device_interfaces
        where ($1::bigint is null or device_id = $1)
        group by 1
        order by 1
      `,
      [deviceId ?? null]
    )
    return result.rows
  })

  app.get('/collection-trend', async (request) => {
    const deviceId = request.query.deviceId
    const interval = rangeInterval(request.query.range)
    const result = await app.db.query(
      `
        with samples as (
          select created_at
          from metric_samples
          where created_at >= now() - $2::interval
            and ($1::bigint is null or device_id = $1)
          union all
          select created_at
          from interface_metric_samples
          where created_at >= now() - $2::interval
            and ($1::bigint is null or device_id = $1)
        )
        select
          to_timestamp(floor(extract(epoch from created_at) / 300) * 300) as time,
          count(*)::integer as count
        from samples
        group by 1
        order by 1
      `,
      [deviceId ?? null, interval]
    )
    return result.rows
  })
}
