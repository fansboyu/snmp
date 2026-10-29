export function discoveryDiagnostics(inventory, links, now = Date.now()) {
  const devices = inventory.devices.map((device) => {
    const scans = inventory.scans.filter((s) => String(s.device_id) === String(device.id))
    const request = inventory.requests?.find((r) => String(r.device_id) === String(device.id))
    const checked = scans.reduce((time, s) => Math.max(time, Date.parse(s.checked_at) || 0), 0)
    const current = scans.filter((s) => now - Date.parse(s.checked_at) < 1200000)
    const good = current.some((s) => ['success', 'empty'].includes(s.status))
    let status = !device.enabled
      ? 'disabled'
      : !checked
        ? 'waiting'
        : now - checked >= 1200000
          ? 'stale'
          : current.some((s) => ['failed', 'partial'].includes(s.status))
            ? good
              ? 'partial'
              : 'failed'
            : good
              ? 'success'
              : 'unsupported'
    if (device.enabled && request && ['pending', 'running'].includes(request.status)) {
      status =
        now - Date.parse(request.created_at) > 600000 ||
        (request.status === 'running' && now - Date.parse(request.started_at) > 120000)
          ? 'expired'
          : request.status
    }
    if (
      device.enabled &&
      request?.status === 'failed' &&
      Date.parse(request.finished_at) >= checked
    )
      status = 'failed'
    return {
      id: device.id,
      name: device.name,
      host: device.host,
      enabled: device.enabled,
      status,
      checked_at: checked ? new Date(checked).toISOString() : null,
      request,
      scans,
    }
  })
  const active = inventory.neighbors.filter(
    (n) => !n.stale && now - Date.parse(n.last_seen_at) < 1200000,
  )
  return {
    devices,
    summary: {
      total: devices.filter((d) => d.enabled).length,
      attempted: devices.filter((d) => d.enabled && d.checked_at).length,
      successful: devices.filter((d) => d.status === 'success').length,
      pending: devices.filter((d) => ['pending', 'running'].includes(d.status)).length,
      evidence: active.length,
      unmatched: active.filter((n) => n.match_state !== 'matched').length,
      unmapped_ports: active.filter(
        (n) => n.match_state === 'matched' && (!n.local_interface_id || !n.remote_interface_id),
      ).length,
      links: links.filter((l) => l.auto_discovered && l.status !== 'stale').length,
    },
  }
}

export async function topologyDiscoveryRoutes(app) {
  app.post('/devices/:id/scan', async (request, reply) => {
    if (!/^\d{1,18}$/.test(request.params.id))
      return reply.code(400).send({ message: '无效设备编号' })
    const client = await app.db.connect()
    try {
      await client.query('begin')
      const device = (
        await client.query('select id,enabled from devices where id=$1 for update', [
          request.params.id,
        ])
      ).rows[0]
      if (!device) return await reject(404, '设备不存在')
      if (!device.enabled) return await reject(400, '请先启用设备采集')
      await client.query(
        `update topology_scan_requests set status='failed',finished_at=now(),reason='请求已超时，请重新采集'
        where device_id=$1 and ((status='pending' and created_at<now()-interval '10 minutes') or (status='running' and started_at<now()-interval '2 minutes'))`,
        [device.id],
      )
      const active = (
        await client.query(
          "select * from topology_scan_requests where device_id=$1 and status in ('pending','running')",
          [device.id],
        )
      ).rows[0]
      if (active) {
        await client.query('commit')
        return reply.code(202).send(active)
      }
      const recent = (
        await client.query(
          "select id from topology_scan_requests where device_id=$1 and created_at>now()-interval '30 seconds' limit 1",
          [device.id],
        )
      ).rowCount
      if (recent) return await reject(429, '请等待 30 秒后再提交采集')
      const result = await client.query(
        "insert into topology_scan_requests(device_id,reason) values($1,'已排队，等待采集器领取；同设备任务串行执行') returning *",
        [device.id],
      )
      await client.query('commit')
      return reply.code(202).send(result.rows[0])
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    async function reject(code, message) {
      await client.query('rollback')
      return reply.code(code).send({ message })
    }
  })
}
