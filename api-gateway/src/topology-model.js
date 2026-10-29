export const normalizePort = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^(ten[-]?gigabitethernet|xgigabitethernet|10gigabitethernet|xge|te)(?=\d)/, '10ge')
    .replace(/^(gigabitethernet|gigethernet|gi)(?=\d)/, 'ge')
    .replace(/^(fastethernet|fa)(?=\d)/, 'fe')
    .replace(/^(ethernet|et)(?=\d)/, 'eth')
export const normalizeIdentity = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
export const normalizeChassis = (value) => normalizeIdentity(value).replace(/[^a-z0-9]/g, '')
const idOrder = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

export function resolveNeighbor(row, devices, ports, identities, binding) {
  let candidates = []
  let basis = 'unmatched'
  if (binding) {
    candidates = devices.filter((d) => String(d.id) === String(binding.remote_device_id))
    basis = 'manual'
  } else {
    const address = String(row.remote_mgmt_address || '').split('/')[0]
    candidates = devices.filter((d) => address && String(d.host).split('/')[0] === address)
    basis = 'address'
    if (!candidates.length && row.remote_chassis_id) {
      const ids = identities
        .filter(
          (i) =>
            i.kind === 'chassis' &&
            normalizeChassis(i.value) === normalizeChassis(row.remote_chassis_id),
        )
        .map((i) => String(i.device_id))
      candidates = devices.filter((d) => ids.includes(String(d.id)))
      basis = 'chassis'
    }
    if (!candidates.length) {
      const names = [row.remote_sys_name, row.remote_device_name]
        .map(normalizeIdentity)
        .filter(Boolean)
      candidates = devices.filter(
        (d) =>
          names.includes(normalizeIdentity(d.name)) ||
          identities.some(
            (i) =>
              String(i.device_id) === String(d.id) &&
              i.kind === 'sysname' &&
              names.includes(normalizeIdentity(i.value)),
          ),
      )
      basis = 'name'
      if (!candidates.length) {
        candidates = devices.filter((d) =>
          names.some((name) => name.split('.')[0] === normalizeIdentity(d.name).split('.')[0]),
        )
        basis = 'short_name'
      }
    }
  }
  candidates = candidates.filter((d) => String(d.id) !== String(row.device_id))
  const remote = candidates.length === 1 && basis !== 'short_name' ? candidates[0] : null
  const matchPort = (device, explicit, values) => {
    const owned = ports.filter((p) => String(p.device_id) === String(device))
    if (explicit) {
      const p = owned.find((p) => String(p.id) === String(explicit))
      if (p) return p.id
    }
    const keys = values.map(normalizePort).filter(Boolean)
    const exact = owned.filter((p) =>
      [p.if_name, p.if_descr].some((v) => keys.includes(normalizePort(v)) && normalizePort(v)),
    )
    if (exact.length) return exact.length === 1 ? exact[0].id : null
    const aliases = owned.filter((p) => p.if_alias && keys.includes(normalizePort(p.if_alias)))
    return aliases.length === 1 ? aliases[0].id : null
  }
  const indexed = ports.filter(
    (p) =>
      String(p.device_id) === String(row.device_id) &&
      Number(row.local_if_index) > 0 &&
      Number(p.if_index) === Number(row.local_if_index),
  )
  const local =
    indexed.length === 1
      ? indexed[0].id
      : matchPort(row.device_id, null, [row.local_port_id, row.local_port_descr])
  const remotePort = remote
    ? matchPort(remote.id, binding?.remote_interface_id, [
        row.remote_port_id,
        row.remote_port_descr,
      ])
    : null
  return {
    ...row,
    local_interface_id: local,
    remote_device_id: remote?.id ?? null,
    remote_interface_id: remotePort,
    remote_device_name_matched: remote?.name ?? null,
    match_state: remote
      ? 'matched'
      : candidates.length > 1
        ? 'conflict'
        : basis === 'short_name' && candidates.length
          ? 'needs_confirmation'
          : 'unmatched',
    match_basis: basis,
    candidates: candidates.map((d) => ({ id: d.id, name: d.name })),
    binding_locked: Boolean(binding),
  }
}

// Fill partial observations only from a unique fully mapped connection sharing
// a known physical port. Never merge by device pair alone (parallel uplinks).
export function reconcileNeighborPorts(rows, ports) {
  const align = (n) =>
    BigInt(n.device_id) < BigInt(n.remote_device_id)
      ? [
          n.local_interface_id,
          n.remote_interface_id,
          n.local_port_id || n.local_port_descr,
          n.remote_port_id || n.remote_port_descr,
        ]
      : [
          n.remote_interface_id,
          n.local_interface_id,
          n.remote_port_id || n.remote_port_descr,
          n.local_port_id || n.local_port_descr,
        ]
  return rows.map((row) => {
    if (
      !row.remote_device_id ||
      row.stale ||
      Date.now() - Date.parse(row.last_seen_at) > 1200000 ||
      (row.local_interface_id && row.remote_interface_id)
    )
      return row
    const a = align(row)
    const compatible = (id, text, candidate) => {
      if (id) return String(id) === String(candidate)
      if (!text) return true
      const port = ports.find((p) => String(p.id) === String(candidate))
      return (
        port &&
        [port.if_name, port.if_descr, port.if_alias].some(
          (v) => v && normalizePort(v) === normalizePort(text),
        )
      )
    }
    const candidates = rows
      .filter(
        (n) =>
          n.remote_device_id &&
          !n.stale &&
          Date.now() - Date.parse(n.last_seen_at) <= 1200000 &&
          n.local_interface_id &&
          n.remote_interface_id &&
          [String(n.device_id), String(n.remote_device_id)].sort().join(':') ===
            [String(row.device_id), String(row.remote_device_id)].sort().join(':'),
      )
      .map(align)
      .filter(
        (b) =>
          ((a[0] && String(a[0]) === String(b[0])) || (a[1] && String(a[1]) === String(b[1]))) &&
          compatible(a[0], a[2], b[0]) &&
          compatible(a[1], a[3], b[1]),
      )
    const unique = new Map(candidates.map((c) => [c.slice(0, 2).join(':'), c]))
    if (unique.size !== 1) return row
    const pair = [...unique.values()][0]
    const ordered = BigInt(row.device_id) < BigInt(row.remote_device_id) ? pair : [pair[1], pair[0]]
    return { ...row, local_interface_id: ordered[0], remote_interface_id: ordered[1] }
  })
}

export function physicalIdentity(row) {
  const local = String(row.device_id)
  const remote = row.remote_device_id
    ? String(row.remote_device_id)
    : `unknown:${normalizeIdentity(row.remote_mgmt_address || row.remote_chassis_id || row.remote_sys_name || row.remote_device_name || row.id)}`
  const endpoint = (id, port, text) =>
    `${id}@${port ? `if:${port}` : `port:${normalizePort(text) || '?'}`}`
  let a = endpoint(
    local,
    row.local_interface_id,
    row.local_port_id || row.local_port_descr || row.local_if_index,
  )
  let b = endpoint(remote, row.remote_interface_id, row.remote_port_id || row.remote_port_descr)
  if (remote.startsWith('unknown:') ? a > b : idOrder(local, remote) > 0) [a, b] = [b, a]
  return `${a}|${b}`
}

export function deriveLinkState(link, ports, evidence, nodes, now = Date.now()) {
  const endpoints = [link.source_interface_id, link.target_interface_id]
    .filter(Boolean)
    .map((id) => ports.find((p) => String(p.id) === String(id)))
    .filter(Boolean)
  const fresh = (p) => p.last_seen_at && now - Date.parse(p.last_seen_at) <= 180000
  if (endpoints.some((p) => fresh(p) && ['2', 'down'].includes(String(p.admin_status))))
    return { status: 'disabled', reason: '端口管理关闭' }
  if (endpoints.some((p) => fresh(p) && ['2', 'down'].includes(String(p.oper_status))))
    return { status: 'down', reason: '最新端口运行状态为 DOWN' }
  if (nodes.some((n) => n.device_status === 'offline'))
    return { status: 'down', reason: '端点设备已确认不可达；不代表物理线缆断开' }
  const current = evidence.filter((n) => !n.stale && now - Date.parse(n.last_seen_at) <= 1200000)
  if (link.auto_discovered && !current.length)
    return { status: 'stale', reason: '邻居证据过期，连接关系待确认' }
  if (
    endpoints.length === 2 &&
    endpoints.every((p) => fresh(p) && ['1', 'up'].includes(String(p.oper_status)))
  )
    return { status: 'up', reason: '两端端口最新状态均为 UP' }
  return {
    status: link.auto_discovered ? 'unconfirmed' : 'unknown',
    reason: current.length ? '已发现连接，缺少两端有效端口状态' : '手工连接，尚无完整运行证据',
  }
}

export function layoutTopology(nodes, links) {
  const degree = new Map(nodes.map((n) => [String(n.id), 0]))
  for (const l of links) {
    for (const id of [l.source_node_id, l.target_node_id])
      degree.set(String(id), (degree.get(String(id)) || 0) + 1)
  }
  const rank = { core: 0, aggregation: 1, access: 2, external: 3 }
  const sorted = [...nodes].sort(
    (a, b) =>
      (rank[a.layer] ?? 2) - (rank[b.layer] ?? 2) ||
      (degree.get(String(b.id)) || 0) - (degree.get(String(a.id)) || 0) ||
      idOrder(a.id, b.id),
  )
  const occupied = nodes
    .filter((n) => n.position_locked)
    .map((n) => ({
      x: Number(n.x),
      y: Number(n.y),
      width: Number(n.width),
      height: Number(n.height),
    }))
  return sorted.map((n) => {
    if (n.position_locked) return { ...n }
    const layer = rank[n.layer] ?? 2
    let column = 0,
      x,
      y
    do {
      x = 60 + column++ * 250
      y = 60 + layer * 180
    } while (
      occupied.some(
        (p) =>
          x < p.x + p.width + 30 &&
          x + Number(n.width) + 30 > p.x &&
          y < p.y + p.height + 30 &&
          y + Number(n.height) + 30 > p.y,
      )
    )
    occupied.push({ x, y, width: Number(n.width), height: Number(n.height) })
    return { ...n, x, y }
  })
}
