const MAX_HOSTS = 256

export async function discoveryRoutes(app) {
  app.post('/jobs', async (request, reply) => {
    const {
      cidr,
      port = 161,
      community = 'public',
      timeout_ms = 1000,
      retries = 0,
      concurrency = 16
    } = request.body ?? {}

    const validation = validateDiscoveryJob({ cidr, port, community, timeout_ms, retries, concurrency })
    if (!validation.ok) {
      reply.code(400)
      return { message: validation.message }
    }

    const result = await app.db.query(
      `
        insert into discovery_jobs (
          cidr,
          port,
          snmp_version,
          community,
          timeout_ms,
          retries,
          concurrency,
          total_hosts,
          status
        )
        values ($1, $2, '2c', $3, $4, $5, $6, $7, 'pending')
        returning
          id,
          cidr,
          port,
          snmp_version,
          timeout_ms,
          retries,
          concurrency,
          status,
          total_hosts,
          scanned_hosts,
          discovered_hosts,
          error_message,
          started_at,
          finished_at,
          created_at,
          updated_at
      `,
      [cidr.trim(), port, community.trim(), timeout_ms, retries, concurrency, validation.totalHosts]
    )

    reply.code(201)
    return { ...result.rows[0], community: maskSecret(community) }
  })

  app.get('/jobs', async (request) => {
    const limit = clampNumber(Number(request.query.limit ?? 50), 1, 200)
    const result = await app.db.query(
      `
        select
          id,
          cidr,
          port,
          snmp_version,
          case when community is null or community = '' then '' else '******' end as community,
          timeout_ms,
          retries,
          concurrency,
          status,
          total_hosts,
          scanned_hosts,
          discovered_hosts,
          error_message,
          started_at,
          finished_at,
          created_at,
          updated_at
        from discovery_jobs
        order by created_at desc
        limit $1
      `,
      [limit]
    )
    return result.rows
  })

  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        select
          id,
          cidr,
          port,
          snmp_version,
          case when community is null or community = '' then '' else '******' end as community,
          timeout_ms,
          retries,
          concurrency,
          status,
          total_hosts,
          scanned_hosts,
          discovered_hosts,
          error_message,
          started_at,
          finished_at,
          created_at,
          updated_at
        from discovery_jobs
        where id = $1
      `,
      [id]
    )
    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'discovery job not found' }
    }
    return result.rows[0]
  })

  app.patch('/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params
    const result = await app.db.query(
      `
        update discovery_jobs
        set status = 'canceled',
          finished_at = coalesce(finished_at, now()),
          updated_at = now()
        where id = $1 and status in ('pending', 'running')
        returning *
      `,
      [id]
    )
    if (result.rowCount === 0) {
      reply.code(404)
      return { message: 'discovery job not found or not cancelable' }
    }
    return result.rows[0]
  })

  app.get('/jobs/:id/results', async (request) => {
    const { id } = request.params
    const imported = request.query.imported
    const limit = clampNumber(Number(request.query.limit ?? 200), 1, 500)
    const result = await app.db.query(
      `
        select
          r.id,
          r.job_id,
          host(r.host) as host,
          r.port,
          r.snmp_version,
          r.sys_name,
          r.sys_descr,
          r.sys_object_id,
          r.response_ms,
          r.status,
          r.device_id,
          d.name as device_name,
          r.error_message,
          r.discovered_at,
          r.imported_at
        from discovery_results r
        left join devices d on d.id = r.device_id
        where r.job_id = $1
          and (
            $2::text is null
            or ($2 = 'true' and r.device_id is not null)
            or ($2 = 'false' and r.device_id is null)
          )
        order by r.discovered_at desc, r.id desc
        limit $3
      `,
      [id, imported ?? null, limit]
    )
    return result.rows
  })

  app.post('/results/import', async (request, reply) => {
    const {
      resultIds = [],
      group_id = null,
      enabled = false
    } = request.body ?? {}

    if (!Array.isArray(resultIds) || resultIds.length === 0) {
      reply.code(400)
      return { message: 'resultIds is required' }
    }

    const client = await app.db.connect()
    const imported = []
    const skipped = []
    try {
      await client.query('begin')
      for (const resultId of resultIds) {
        const result = await client.query(
          `
            select
              r.id,
              host(r.host) as host,
              r.port,
              r.snmp_version,
              r.sys_name,
              j.community,
              r.device_id
            from discovery_results r
            join discovery_jobs j on j.id = r.job_id
            where r.id = $1
            for update
          `,
          [resultId]
        )
        if (result.rowCount === 0) {
          skipped.push({ resultId, reason: 'not_found' })
          continue
        }

        const row = result.rows[0]
        if (row.device_id) {
          skipped.push({ resultId, reason: 'already_imported', deviceId: row.device_id })
          continue
        }

        const existing = await client.query(
          `
            select id, name
            from devices
            where host = $1::inet and port = $2 and snmp_version = $3
            limit 1
          `,
          [row.host, row.port, row.snmp_version]
        )
        if (existing.rowCount > 0) {
          await client.query(
            `
              update discovery_results
              set device_id = $2,
                status = 'imported',
                imported_at = now()
              where id = $1
            `,
            [resultId, existing.rows[0].id]
          )
          skipped.push({ resultId, reason: 'device_exists', deviceId: existing.rows[0].id })
          continue
        }

        const deviceName = row.sys_name || `Discovered ${row.host}`
        const device = await client.query(
          `
            insert into devices (
              name,
              host,
              port,
              group_id,
              community,
              snmp_version,
              enabled
            )
            values ($1, $2::inet, $3, $4, $5, '2c', $6)
            returning id, name, host(host) as host, port, enabled
          `,
          [deviceName, row.host, row.port, group_id || null, row.community || 'public', enabled]
        )
        await client.query(
          `
            update discovery_results
            set device_id = $2,
              status = 'imported',
              imported_at = now()
            where id = $1
          `,
          [resultId, device.rows[0].id]
        )
        imported.push(device.rows[0])
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }

    return { imported, skipped }
  })
}

function validateDiscoveryJob(payload) {
  const cidr = String(payload.cidr ?? '').trim()
  const parsed = parseIpv4Cidr(cidr)
  if (!parsed) return { ok: false, message: 'cidr must be a valid IPv4 CIDR' }
  if (parsed.totalHosts > MAX_HOSTS) {
    return { ok: false, message: `cidr is too large, max ${MAX_HOSTS} hosts` }
  }
  if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
    return { ok: false, message: 'port must be between 1 and 65535' }
  }
  if (String(payload.community ?? '').trim() === '') {
    return { ok: false, message: 'community is required' }
  }
  if (!Number.isInteger(payload.timeout_ms) || payload.timeout_ms < 500 || payload.timeout_ms > 5000) {
    return { ok: false, message: 'timeout_ms must be between 500 and 5000' }
  }
  if (!Number.isInteger(payload.retries) || payload.retries < 0 || payload.retries > 2) {
    return { ok: false, message: 'retries must be between 0 and 2' }
  }
  if (!Number.isInteger(payload.concurrency) || payload.concurrency < 1 || payload.concurrency > 64) {
    return { ok: false, message: 'concurrency must be between 1 and 64' }
  }
  return { ok: true, totalHosts: parsed.totalHosts }
}

function parseIpv4Cidr(cidr) {
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (!match) return null
  const octets = match[1].split('.').map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return null
  const prefix = Number(match[2])
  if (prefix < 24 || prefix > 32) return null
  const totalHosts = 2 ** (32 - prefix)
  return { totalHosts }
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function maskSecret(value) {
  return value ? '******' : ''
}
