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
