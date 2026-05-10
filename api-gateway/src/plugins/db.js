import fp from 'fastify-plugin'
import pg from 'pg'

export const dbPlugin = fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: app.config.DATABASE_URL
  })

  app.decorate('db', pool)
  await pool.query(`
    alter table alert_notifications add column if not exists subject text;
    alter table alert_notifications add column if not exists error text;
    alter table alert_notifications add column if not exists retry_count integer not null default 0;
    alter table alert_notifications add column if not exists next_retry_at timestamptz not null default now();
    alter table alert_notifications add column if not exists updated_at timestamptz not null default now();
    create index if not exists idx_alert_notifications_pending
      on alert_notifications(status, next_retry_at);
    create unique index if not exists uq_alert_notifications_event_channel_target_subject
      on alert_notifications(event_id, channel, target, subject);
    create table if not exists discovery_jobs (
      id bigserial primary key,
      cidr text not null,
      port integer not null default 161,
      snmp_version text not null default '2c',
      community text,
      timeout_ms integer not null default 1000,
      retries integer not null default 0,
      concurrency integer not null default 16,
      status text not null default 'pending',
      total_hosts integer not null default 0,
      scanned_hosts integer not null default 0,
      discovered_hosts integer not null default 0,
      error_message text,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists discovery_results (
      id bigserial primary key,
      job_id bigint not null references discovery_jobs(id) on delete cascade,
      host inet not null,
      port integer not null default 161,
      snmp_version text not null default '2c',
      sys_name text,
      sys_descr text,
      sys_object_id text,
      response_ms integer,
      status text not null default 'discovered',
      device_id bigint references devices(id) on delete set null,
      error_message text,
      discovered_at timestamptz not null default now(),
      imported_at timestamptz,
      unique (job_id, host, port)
    );
    create index if not exists idx_discovery_jobs_status_created
      on discovery_jobs(status, created_at desc);
    create index if not exists idx_discovery_results_job_id
      on discovery_results(job_id);
    create index if not exists idx_discovery_results_host
      on discovery_results(host);
  `)

  app.addHook('onClose', async () => {
    await pool.end()
  })
})
