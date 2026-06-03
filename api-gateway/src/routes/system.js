async function deleteOldRows(app, query, retentionDays, batchSize) {
  let total = 0

  for (;;) {
    const result = await app.db.query(query, [retentionDays, batchSize])
    total += result.rowCount
    if (result.rowCount < batchSize) {
      return total
    }
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

export async function systemRoutes(app) {
  app.get('/storage', async () => {
    const database = await app.db.query(`
      select
        current_database() as database_name,
        pg_database_size(current_database())::bigint as database_bytes,
        pg_size_pretty(pg_database_size(current_database())) as database_size
    `)
    const tables = await app.db.query(`
      select
        count(*)::bigint as metric_samples,
        (select count(*)::bigint from interface_metric_samples) as interface_samples,
        (select count(*)::bigint from alert_notifications) as alert_notifications,
        (select count(*)::bigint from discovery_jobs) as discovery_jobs
      from metric_samples
    `)

    return {
      database: database.rows[0],
      rows: tables.rows[0]
    }
  })

  app.post('/cleanup', async (request) => {
    const body = request.body ?? {}
    const retentionDays = {
      metricSamples: positiveNumber(body.metricSamplesDays, 30),
      interfaceSamples: positiveNumber(body.interfaceSamplesDays, 30),
      resolvedAlerts: positiveNumber(body.resolvedAlertsDays, 90),
      alertNotifications: positiveNumber(body.alertNotificationsDays, 90),
      discoveryHistory: positiveNumber(body.discoveryHistoryDays, 30)
    }
    const batchSize = positiveNumber(body.batchSize, 5000)

    const stats = {
      metricSamples: 0,
      interfaceSamples: 0,
      resolvedAlerts: 0,
      alertNotifications: 0,
      discoveryJobs: 0
    }

    stats.interfaceSamples = await deleteOldRows(app, `
      delete from interface_metric_samples
      where id in (
        select id
        from interface_metric_samples
        where created_at < now() - make_interval(days => $1)
        order by created_at
        limit $2
      )
    `, retentionDays.interfaceSamples, batchSize)

    stats.metricSamples = await deleteOldRows(app, `
      delete from metric_samples
      where id in (
        select id
        from metric_samples
        where created_at < now() - make_interval(days => $1)
        order by created_at
        limit $2
      )
    `, retentionDays.metricSamples, batchSize)

    stats.resolvedAlerts = await deleteOldRows(app, `
      delete from alert_events
      where id in (
        select id
        from alert_events
        where status = 'resolved'
          and coalesce(resolved_at, last_seen_at, triggered_at) < now() - make_interval(days => $1)
        order by coalesce(resolved_at, last_seen_at, triggered_at)
        limit $2
      )
    `, retentionDays.resolvedAlerts, batchSize)

    stats.alertNotifications = await deleteOldRows(app, `
      delete from alert_notifications
      where id in (
        select id
        from alert_notifications
        where created_at < now() - make_interval(days => $1)
        order by created_at
        limit $2
      )
    `, retentionDays.alertNotifications, batchSize)

    stats.discoveryJobs = await deleteOldRows(app, `
      delete from discovery_jobs
      where id in (
        select id
        from discovery_jobs
        where created_at < now() - make_interval(days => $1)
          and status in ('completed', 'failed', 'canceled')
        order by created_at
        limit $2
      )
    `, retentionDays.discoveryHistory, batchSize)

    return {
      retentionDays,
      batchSize,
      deleted: stats
    }
  })
}
