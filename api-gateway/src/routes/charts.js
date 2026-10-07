import { buildTraffic, loadTrafficRows, trafficWindow } from '../port-traffic.js'
const rangeMap = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days'
}

const rollupBucketSeconds = 300

function rangeInterval(range) {
  return rangeMap[range] ?? rangeMap['1h']
}

function shouldUseRollup(range) {
  return range && range !== '1h'
}

export async function chartRoutes(app) {
  app.get('/cpu', async (request) => {
    const deviceId = request.query.deviceId
    const range = request.query.range
    const interval = rangeInterval(request.query.range)
    if (shouldUseRollup(range)) {
      const result = await app.db.query(
        `
          select
            r.bucket_start as time,
            avg(r.avg_value) as value
          from metric_sample_rollups r
          join metric_definitions m on m.id = r.metric_id
          where r.bucket_seconds = $3
            and r.bucket_start >= now() - $2::interval
            and ($1::bigint is null or r.device_id = $1)
            and (m.display_group = 'cpu' or m.name ilike '%cpu%' or m.name = 'hrProcessorLoad')
          group by 1
          order by 1
        `,
        [deviceId ?? null, interval, rollupBucketSeconds]
      )
      return result.rows.map((row) => ({
        time: row.time,
        value: row.value === null ? null : Number(row.value)
      }))
    }
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
    const range = request.query.range
    const interval = rangeInterval(request.query.range)
    if (shouldUseRollup(range)) {
      const result = await app.db.query(
        `
          select
            r.bucket_start as time,
            avg(r.avg_value) as value
          from metric_sample_rollups r
          join metric_definitions m on m.id = r.metric_id
          where r.bucket_seconds = $3
            and r.bucket_start >= now() - $2::interval
            and ($1::bigint is null or r.device_id = $1)
            and (m.display_group = 'memory' or m.name ilike '%mem%' or m.name ilike '%memory%')
          group by 1
          order by 1
        `,
        [deviceId ?? null, interval, rollupBucketSeconds]
      )
      return result.rows.map((row) => ({
        time: row.time,
        value: row.value === null ? null : Number(row.value)
      }))
    }
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
    const window=trafficWindow(request.query)
    const interfaces=await app.db.query('select * from device_interfaces where ($1::bigint is null or device_id=$1) and ($2::bigint is null or id=$2)',[request.query.deviceId??null,request.query.interfaceId??null])
    const rows=await loadTrafficRows(app.db,interfaces.rows.map(i=>i.id),window)
    const grouped=new Map()
    for(const row of rows){const id=String(row.interface_id);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(row)}
    const buckets=new Map()
    for(const iface of interfaces.rows){for(const point of buildTraffic(grouped.get(String(iface.id))||[],iface,window).points){
      const key=new Date(point.time).toISOString();const bucket=buckets.get(key)||{time:key,in_bps:null,out_bps:null}
      for(const field of ['in_bps','out_bps'])if(point[field]!=null)bucket[field]=(bucket[field]??0)+point[field]
      buckets.set(key,bucket)
    }}
    return Array.from(buckets.values()).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))
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
    const range = request.query.range
    const interval = rangeInterval(request.query.range)
    if (shouldUseRollup(range)) {
      const result = await app.db.query(
        `
          with samples as (
            select bucket_start, sample_count
            from metric_sample_rollups
            where bucket_seconds = $3
              and bucket_start >= now() - $2::interval
              and ($1::bigint is null or device_id = $1)
            union all
            select bucket_start, sample_count
            from interface_metric_sample_rollups
            where bucket_seconds = $3
              and bucket_start >= now() - $2::interval
              and ($1::bigint is null or device_id = $1)
          )
          select
            bucket_start as time,
            sum(sample_count)::integer as count
          from samples
          group by 1
          order by 1
        `,
        [deviceId ?? null, interval, rollupBucketSeconds]
      )
      return result.rows
    }
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
