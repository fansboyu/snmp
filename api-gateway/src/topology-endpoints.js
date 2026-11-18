const FRESH_WINDOW = `interval '30 minutes'`
const UPLINK_WINDOW = `interval '20 minutes'`
const SHARED_PORT_MAC_LIMIT = 20

export async function readTopologyEndpointSummary(db) {
  const result = await db.query(`
    with fresh_macs as (
      select distinct on (device_id, vlan_id, mac_address)
        device_id, vlan_id, mac_address, if_index, observed_at
      from switch_mac_observations
      where active and observed_at > now()-${FRESH_WINDOW}
      order by device_id, vlan_id, mac_address, observed_at desc
    ), port_counts as (
      select device_id, if_index, count(distinct mac_address)::integer as mac_count
      from fresh_macs group by device_id, if_index
    ), classified as (
      select f.*,
        p.mac_count as port_mac_count,
        exists (
          select 1 from device_neighbors n
          where n.device_id=f.device_id and n.local_if_index=f.if_index
            and not n.stale and n.last_seen_at > now()-${UPLINK_WINDOW}
        ) as known_network_port,
        exists (
          select 1 from ip_mac_observations i
          where i.mac_address=f.mac_address and i.active
            and i.observed_at > now()-${FRESH_WINDOW}
            and (f.vlan_id=0 or i.vlan_id=0 or i.vlan_id=f.vlan_id)
        ) as has_ip
      from fresh_macs f
      join port_counts p using (device_id, if_index)
    )
    select device_id,
      count(distinct mac_address)::integer as mac_count,
      count(distinct mac_address) filter (
        where not known_network_port and port_mac_count < $1
      )::integer as terminal_count,
      count(distinct mac_address) filter (
        where not known_network_port and port_mac_count < $1 and has_ip
      )::integer as ip_count,
      count(distinct mac_address) filter (where known_network_port)::integer as known_uplink_mac_count,
      count(distinct mac_address) filter (
        where not known_network_port and port_mac_count >= $1
      )::integer as shared_port_mac_count,
      max(observed_at) as observed_at
    from classified group by device_id
  `, [SHARED_PORT_MAC_LIMIT])
  return result.rows
}

export async function readTopologyNodeEndpoints(db, mapId, nodeId) {
  const nodeResult = await db.query(`
    select n.id,n.device_id,d.name as device_name
    from topology_nodes n left join devices d on d.id=n.device_id
    where n.id=$1 and n.map_id=$2
  `, [nodeId, mapId])
  const node = nodeResult.rows[0]
  if (!node) return null
  if (!node.device_id) {
    return {
      device_id: null,
      device_name: null,
      summary: emptyEndpointSummary('not_collected'),
      items: [],
      scans: [],
    }
  }

  const [itemsResult, scansResult] = await Promise.all([
    db.query(`
      with fresh_macs as (
        select distinct on (device_id,vlan_id,mac_address)
          device_id,vlan_id,mac_address,if_index,observed_at
        from switch_mac_observations
        where device_id=$1 and active and observed_at>now()-${FRESH_WINDOW}
        order by device_id,vlan_id,mac_address,observed_at desc
      ), port_counts as (
        select device_id,if_index,count(distinct mac_address)::integer as mac_count
        from fresh_macs group by device_id,if_index
      )
      select f.vlan_id,f.mac_address,f.if_index,f.observed_at,
        coalesce(p.if_name,p.if_descr,p.if_alias,'ifIndex '||f.if_index::text) as interface_name,
        p.if_alias as interface_alias,
        pc.mac_count as port_mac_count,
        exists (
          select 1 from device_neighbors n where n.device_id=f.device_id
            and n.local_if_index=f.if_index and not n.stale
            and n.last_seen_at>now()-${UPLINK_WINDOW}
        ) as known_network_port,
        ip.ip_address,ip.vlan_id as ip_vlan_id,ip.device_id as ip_source_device_id,
        ip.device_name as ip_source_device_name,ip.observed_at as ip_seen_at,ip.location_count
      from fresh_macs f
      join port_counts pc using(device_id,if_index)
      left join device_interfaces p on p.device_id=f.device_id and p.if_index=f.if_index
      left join lateral (
        select chosen.ip_address,chosen.vlan_id,chosen.device_id,chosen.device_name,
          chosen.observed_at,locations.location_count
        from (
          select host(i.ip_address) as ip_address,i.vlan_id,i.device_id,d.name as device_name,i.observed_at
          from ip_mac_observations i left join devices d on d.id=i.device_id
          where i.mac_address=f.mac_address and i.active
            and i.observed_at>now()-${FRESH_WINDOW}
            and (f.vlan_id=0 or i.vlan_id=0 or i.vlan_id=f.vlan_id)
          order by (f.vlan_id>0 and i.vlan_id=f.vlan_id) desc,i.observed_at desc
          limit 1
        ) chosen
        left join lateral (
          select count(distinct (i.device_id,i.if_index))::integer as location_count
          from ip_mac_observations i
          where i.mac_address=f.mac_address and i.ip_address=chosen.ip_address::inet
            and i.vlan_id=chosen.vlan_id and i.active
            and i.observed_at>now()-${FRESH_WINDOW}
        ) locations on true
      ) ip on true
      order by f.if_index,f.vlan_id,f.mac_address
    `, [node.device_id]),
    db.query(`
      select protocol,status,reason,checked_at,last_success_at,neighbor_count
      from topology_scans where device_id=$1 and protocol in ('qbridge_fdb','bridge_fdb','arp')
      order by protocol
    `, [node.device_id]),
  ])

  const items = itemsResult.rows.map((row) => {
    const knownNetworkPort = row.known_network_port
    const sharedPort = !knownNetworkPort && Number(row.port_mac_count) >= SHARED_PORT_MAC_LIMIT
    return {
      ...row,
      row_key: `${row.vlan_id}:${row.if_index}:${row.mac_address}`,
      vlan_id: row.vlan_id || null,
      ip_vlan_id: row.ip_vlan_id || null,
      ip_address: row.ip_address || null,
      endpoint_kind: knownNetworkPort ? 'network_link' : sharedPort ? 'shared_port' : 'terminal_estimate',
      exclusion_reason: knownNetworkPort
        ? '此端口有近期 LLDP/CDP 邻居证据，按网络设备链路排除'
        : sharedPort
          ? `此端口近期学习到 ${row.port_mac_count} 个 MAC，可能连接 AP 或下级交换机，未计入终端估算`
          : '',
      ip_match_state: !row.ip_address
        ? 'mac_only'
        : Number(row.location_count || 0) === 1
          ? 'unique_candidate'
          : 'ambiguous',
    }
  })
  const terminalItems = items.filter((item) => item.endpoint_kind === 'terminal_estimate')
  const summary = {
    mac_count: new Set(items.map((item) => item.mac_address)).size,
    terminal_count: new Set(terminalItems.map((item) => item.mac_address)).size,
    ip_count: new Set(terminalItems.filter((item) => item.ip_address).map((item) => item.mac_address)).size,
    known_uplink_mac_count: new Set(items.filter((item) => item.endpoint_kind === 'network_link').map((item) => item.mac_address)).size,
    shared_port_mac_count: new Set(items.filter((item) => item.endpoint_kind === 'shared_port').map((item) => item.mac_address)).size,
    observed_at: items.reduce((latest, item) => !latest || Date.parse(item.observed_at) > Date.parse(latest) ? item.observed_at : latest, null),
  }
  const scans = scansResult.rows
  const fdbScan = chooseFdbScan(scans)
  summary.data_status = endpointDataStatus(fdbScan, summary.mac_count > 0)
  summary.checked_at = fdbScan?.checked_at || null
  summary.fdb_protocol = fdbScan?.protocol || null

  return { device_id: node.device_id, device_name: node.device_name, summary, items, scans }
}

export function emptyEndpointSummary(dataStatus) {
  return {
    data_status: dataStatus,
    mac_count: 0,
    terminal_count: 0,
    ip_count: 0,
    known_uplink_mac_count: 0,
    shared_port_mac_count: 0,
    observed_at: null,
    checked_at: null,
    fdb_protocol: null,
  }
}

export function chooseFdbScan(scans) {
  const byProtocol = new Map(scans.map((scan) => [scan.protocol, scan]))
  const qbridge = byProtocol.get('qbridge_fdb')
  const bridge = byProtocol.get('bridge_fdb')
  if (qbridge && ['success', 'empty'].includes(qbridge.status)) return qbridge
  return bridge || qbridge || null
}

export function endpointDataStatus(scan, hasFreshData) {
  if (!scan) return 'not_collected'
  if (Date.now() - Date.parse(scan.checked_at) > 30 * 60 * 1000) return 'stale'
  if (scan.status === 'empty') return 'empty'
  if (scan.status === 'success') return hasFreshData ? 'fresh' : 'empty'
  if (scan.status === 'unsupported') return 'unsupported'
  if (scan.status === 'failed' || scan.status === 'partial') return 'failed'
  return 'not_collected'
}
