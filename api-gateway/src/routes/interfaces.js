import { buildTraffic, loadTrafficRows, trafficWindow, downsample } from '../port-traffic.js'

const interfaceSelect = `select i.*,d.name as device_name,d.host as device_host,d.group_id,g.name as group_name
  from device_interfaces i join devices d on d.id=i.device_id left join device_groups g on g.id=d.group_id`
export async function interfaceRoutes(app) {
  const getInterface = async (request,reply) => {
    if (!/^\d+$/.test(request.params.id)) { reply.code(400).send({message:'无效端口 ID'}); return null }
    const result=await app.db.query(interfaceSelect+' where i.id=$1',[request.params.id])
    const iface=result.rows[0]
    if (!iface || (request.query.deviceId && String(iface.device_id)!==String(request.query.deviceId))) {
      reply.code(404).send({message:'端口不存在或不属于当前设备'}); return null
    }
    return iface
  }
  app.get('/:id/endpoints', async (request, reply) => {
    const iface = await getInterface(request, reply)
    if (!iface) return
    const result=await app.db.query(`
      with port_macs as (
        select f.device_id,f.vlan_id,f.mac_address,f.if_index,f.observed_at
        from switch_mac_observations f
        where f.device_id=$1 and f.if_index=$2 and f.active and f.observed_at>now()-interval '30 minutes'
      )
      select f.vlan_id,f.mac_address,f.if_index,f.observed_at as mac_seen_at,
        i.ip_address::text as ip_address,i.vlan_id as ip_vlan_id,i.device_id as ip_source_device_id,
        d.name as ip_source_device_name,i.if_index as ip_source_if_index,i.observed_at as ip_seen_at,
        coalesce(ip_locations.location_count,0)::integer as ip_source_count,
        case when f.vlan_id>0 and i.vlan_id=f.vlan_id and locations.location_count=1 and ip_locations.location_count=1 then 'high'
          when i.mac_address is not null and locations.location_count=1 and ip_locations.location_count=1 then 'medium'
          when i.mac_address is not null then 'ambiguous'
          else 'mac_only' end as confidence,
        coalesce(locations.location_count,0)::integer as mac_location_count
      from port_macs f
      left join lateral (
        select n.* from ip_mac_observations n
        where n.mac_address=f.mac_address and n.active and n.observed_at>now()-interval '30 minutes'
          and (f.vlan_id=0 or n.vlan_id=0 or n.vlan_id=f.vlan_id)
        order by n.observed_at desc
      ) i on true
      left join devices d on d.id=i.device_id
      left join lateral (
        select count(distinct (n.device_id,n.if_index))::integer as location_count
        from ip_mac_observations n
        where i.mac_address is not null and n.mac_address=i.mac_address and n.ip_address=i.ip_address
          and n.vlan_id=i.vlan_id and n.active and n.observed_at>now()-interval '30 minutes'
      ) ip_locations on true
      left join lateral (
        select count(distinct (m.device_id,m.if_index))::integer as location_count
        from switch_mac_observations m where m.mac_address=f.mac_address and m.active
          and m.observed_at>now()-interval '30 minutes'
      ) locations on true
      order by f.vlan_id,f.mac_address,i.ip_address
    `, [iface.device_id, iface.if_index])
    const items = result.rows.map(row => ({
      ...row,
      vlan_id: row.vlan_id || null,
      ip_vlan_id: row.ip_vlan_id || null,
      ip_address: row.ip_address || null,
      match_state: row.confidence === 'high' ? 'matched' : row.confidence === 'medium' ? 'candidate' : row.confidence === 'ambiguous' ? 'ambiguous' : 'mac_only'
    }))
    const scans = await app.db.query(`select protocol,status,reason,checked_at,last_success_at,neighbor_count
      from topology_scans where device_id=$1 and protocol in ('qbridge_fdb','bridge_fdb','arp') order by protocol`, [iface.device_id])
    const evidence = await app.db.query(`select
      (select count(*)::integer from device_neighbors n where n.device_id=$1 and n.local_if_index=$2 and not n.stale and n.last_seen_at>now()-interval '20 minutes') as neighbor_count,
      (select count(distinct mac_address)::integer from switch_mac_observations f where f.device_id=$1 and f.if_index=$2 and f.active and f.observed_at>now()-interval '30 minutes') as mac_count`, [iface.device_id, iface.if_index])
    const portEvidence = evidence.rows[0] || { neighbor_count: 0, mac_count: 0 }
    return {
      interface_id: iface.id,
      device_id: iface.device_id,
      if_index: iface.if_index,
      items,
      scans: scans.rows,
      port_evidence: {
        ...portEvidence,
        likely_uplink: Number(portEvidence.neighbor_count) > 0 || Number(portEvidence.mac_count) >= 20
      },
      observed_at: items.reduce((latest, item) => !latest || Date.parse(item.mac_seen_at) > Date.parse(latest) ? item.mac_seen_at : latest, null)
    }
  })
  app.get('/:id', async (request,reply) => {
    const iface=await getInterface(request,reply);if(!iface)return
    const counters=await app.db.query(`select distinct on(m.name) m.name,s.value_text as value,s.created_at as sampled_at
      from interface_metric_samples s join metric_definitions m on m.id=s.metric_id
      where s.interface_id=$1 and m.name in ('ifInErrors','ifOutErrors','ifInDiscards','ifOutDiscards')
      order by m.name,s.created_at desc,s.id desc`,[iface.id])
    return {...iface,error_counters:counters.rows}
  })
  app.get('/:id/traffic-summary', async (request,reply) => {
    const iface=await getInterface(request,reply); if(!iface)return
    const window=trafficWindow({range:'1h'})
    const rows=await loadTrafficRows(app.db,[iface.id],window)
    return buildTraffic(rows,iface,window).summary
  })
  app.get('/:id/traffic', async (request,reply) => {
    const iface=await getInterface(request,reply); if(!iface)return
    const window=trafficWindow(request.query)
    const rows=await loadTrafficRows(app.db,[iface.id],window)
    const result=buildTraffic(rows,iface,window)
    return { ...result, points:downsample(result.points), start:new Date(window.start),end:new Date(window.end),resolution:'采样区间平均速率；超过 600 点按时长降采样' }
  })
  app.patch('/:id/note', {schema:{body:{type:'object',required:['user_note'],additionalProperties:false,properties:{user_note:{type:'string',maxLength:200}}}}},async(request,reply)=>{
    const iface=await getInterface(request,reply);if(!iface)return
    const result=await app.db.query('update device_interfaces set user_note=$2,updated_at=now() where id=$1 returning *',[iface.id,request.body.user_note.trim()])
    return result.rows[0]
  })
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
          i.admin_status,
          i.speed_bps,
          i.user_note,
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
    if(request.query.metadataOnly==='true')return result.rows
    const window=trafficWindow({range:'1h'})
    const trafficRows=await loadTrafficRows(app.db,result.rows.map(i=>i.id),window)
    const grouped=new Map()
    for(const row of trafficRows){const key=String(row.interface_id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row)}
    return result.rows.map(iface=>({...iface,traffic_summary:buildTraffic(grouped.get(String(iface.id))||[],iface,window).summary}))
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
