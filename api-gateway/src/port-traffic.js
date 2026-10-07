const durations = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 }
export function trafficWindow(query = {}, now = Date.now()) {
  if(query.range && !durations[query.range]){const error=new Error('不支持的时间范围');error.statusCode=400;throw error}
  const end = query.end ? Date.parse(query.end) : now
  const start = query.start ? Date.parse(query.start) : end - (durations[query.range] || durations['1h'])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now + 60000 || end - start > durations['7d']) {
    const error = new Error('请选择有效的时间范围，单次最多查询 7 天'); error.statusCode = 400; throw error
  }
  return { start, end }
}

export function counterRate(current, previous, { seconds, speed = null, bits = 64, discontinuity = false } = {}) {
  if (previous == null || current == null) return { value: null, quality: 'insufficient' }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 180) return { value: null, quality: 'gap' }
  if (discontinuity) return { value: null, quality: 'reset' }
  if (!/^\d+$/.test(String(current)) || !/^\d+$/.test(String(previous))) return { value: null, quality: 'unsupported' }
  const a = BigInt(current), b = BigInt(previous), modulus = 1n << BigInt(bits)
  if (a >= modulus || b >= modulus) return { value: null, quality: 'invalid' }
  // A 32-bit byte counter is ambiguous if one full wrap can fit inside the interval.
  if (bits === 32 && (!speed || speed * seconds >= Number(modulus) * 8)) return { value: null, quality: 'ambiguous32' }
  const delta = a >= b ? a - b : bits === 32 ? modulus + a - b : null
  if (delta === null) return { value: null, quality: 'reset' }
  const rate = Number(delta * 8n) / seconds
  if (!Number.isFinite(rate) || (speed && rate > speed * 1.05)) return { value: null, quality: 'invalid' }
  return { value: rate, quality: 'ok' }
}

export function buildTraffic(rows, iface, window, now = Date.now()) {
  const previous = {}, points = [], meta = {}
  let latestCandidate = null
  const counters = { in: ['ifHCInOctets', 'ifInOctets'], out: ['ifHCOutOctets', 'ifOutOctets'] }
  for (const row of rows) {
    const time = new Date(row.time).getTime(), values = row.values
    Object.assign(meta, values)
    const high = Number(meta.ifHighSpeed || 0), low = Number(meta.ifSpeed || 0)
    const speed = high > 0 ? high * 1e6 : low > 0 && low < 4294967295 ? low : null
    const point = { time: new Date(time).toISOString(), in_bps: null, out_bps: null, in_quality: 'unsupported', out_quality: 'unsupported', in_seconds: 0, out_seconds: 0, speed_bps: speed, in_utilization: null, out_utilization: null }
    let hasCounter = false
    for (const [direction, names] of Object.entries(counters)) {
      const name = names.find(n => values[n] != null && /^\d+$/.test(values[n]))
      if (!name) continue
      hasCounter = true
      const old = previous[direction], seconds = old ? (time - old.time) / 1000 : 0
      const discontinuity = old && ((meta.ifCounterDiscontinuityTime != null && old.disc != null && meta.ifCounterDiscontinuityTime !== old.disc) || (row.uptime != null && old.uptime != null && BigInt(row.uptime) < BigInt(old.uptime)))
      const result = old && old.name !== name ? { value: null, quality: 'source_changed' } : counterRate(values[name], old?.value, { seconds, speed, bits: name.startsWith('ifHC') ? 64 : 32, discontinuity })
      point[direction + '_bps'] = result.value
      point[direction + '_quality'] = result.quality
      point[direction + '_seconds'] = result.value == null ? 0 : seconds
      point[direction + '_coverage_seconds'] = result.value == null ? 0 : Math.max(0,(Math.min(time,window.end)-Math.max(old.time,window.start))/1000)
      point[direction + '_utilization'] = result.value == null || !speed ? null : result.value / speed * 100
      previous[direction] = { name, value: values[name], time, disc: meta.ifCounterDiscontinuityTime, uptime: row.uptime }
    }
    if (hasCounter && time <= window.end) latestCandidate=point
    if (hasCounter && time >= window.start && time <= window.end) points.push(point)
  }
  const latest = latestCandidate
  const last = latest?.time || null
  const stale = !last || now - Date.parse(last) > 180000
  const summary = { in_bps: stale ? null : latest.in_bps, out_bps: stale ? null : latest.out_bps,
    in_utilization: stale ? null : latest.in_utilization, out_utilization: stale ? null : latest.out_utilization,
    sampled_at: last, sample_interval_seconds: latest ? Math.max(latest.in_seconds, latest.out_seconds) || null : null,
    data_status: !last ? 'no_data' : stale ? 'stale' : latest.in_bps == null && latest.out_bps == null ? 'invalid' : latest.in_bps == null || latest.out_bps == null ? 'partial' : 'fresh',
    in_quality: latest?.in_quality || 'insufficient', out_quality: latest?.out_quality || 'insufficient',
    counter_bits: previous.in?.name.startsWith('ifHC') || previous.out?.name.startsWith('ifHC') ? 64 : 32 }
  const stats = {}
  for (const direction of ['in','out']) {
    const valid = points.filter(p => p[direction + '_bps'] != null)
    const seconds = valid.reduce((sum,p)=>sum+p[direction + '_coverage_seconds'],0)
    stats[direction] = { average_bps: seconds ? valid.reduce((sum,p)=>sum+p[direction+'_bps']*p[direction+'_coverage_seconds'],0)/seconds : null,
      peak_bps: valid.length ? Math.max(...valid.map(p=>p[direction+'_bps'])) : null,
      coverage_seconds: seconds, sample_count: valid.length }
  }
  return { summary, points, stats }
}

export async function loadTrafficRows(db, ids, window) {
  if (!ids.length) return []
  const result = await db.query(`
    with metrics as (select id,name from metric_definitions where name in
      ('ifInOctets','ifOutOctets','ifHCInOctets','ifHCOutOctets','ifCounterDiscontinuityTime','ifSpeed','ifHighSpeed')),
    before_window as (
      select distinct on (s.interface_id,s.metric_id) s.interface_id,s.metric_id,s.created_at,s.value_text
      from interface_metric_samples s join metrics m on m.id=s.metric_id
      where s.interface_id=any($1::bigint[]) and s.created_at<$2
      order by s.interface_id,s.metric_id,s.created_at desc,s.id desc
    ), samples as (
      select * from before_window union all
      select s.interface_id,s.metric_id,s.created_at,s.value_text from interface_metric_samples s join metrics m on m.id=s.metric_id
      where s.interface_id=any($1::bigint[]) and s.created_at>=$2 and s.created_at<=$3
    ), frames as (
      select s.interface_id,s.created_at as time,jsonb_object_agg(m.name,s.value_text) as values
      from samples s join metrics m on m.id=s.metric_id group by s.interface_id,s.created_at
    ) select f.*,u.value_text as uptime from frames f
    join device_interfaces i on i.id=f.interface_id
    left join lateral (
      select s.value_text from metric_samples s join metric_definitions m on m.id=s.metric_id
      where s.device_id=i.device_id and m.name='sysUpTime' and s.created_at<=f.time and s.value_text ~ '^[0-9]+$'
      order by s.created_at desc limit 1
    ) u on true order by f.interface_id,f.time`, [ids,new Date(window.start),new Date(window.end)])
  return result.rows
}

export function downsample(points, max = 600) {
  if (points.length <= max) return points
  const size = Math.ceil(points.length/max), output=[]
  for (let i=0;i<points.length;i+=size) {
    const group=points.slice(i,i+size), p={...group.at(-1)}
    for (const dir of ['in','out']) {
      const valid=group.filter(x=>x[dir+'_bps']!=null), seconds=valid.reduce((s,x)=>s+x[dir+'_seconds'],0)
      p[dir+'_bps']=valid.length===group.length && seconds ? valid.reduce((s,x)=>s+x[dir+'_bps']*x[dir+'_seconds'],0)/seconds : null
      p[dir+'_utilization']=p[dir+'_bps']!=null && p.speed_bps ? p[dir+'_bps']/p.speed_bps*100 : null
    }
    output.push(p)
  }
  return output
}
