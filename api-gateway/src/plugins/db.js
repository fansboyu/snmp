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
    create table if not exists topology_maps (
      id bigserial primary key,
      name text not null unique,
      description text,
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists topology_nodes (
      id bigserial primary key,
      map_id bigint not null references topology_maps(id) on delete cascade,
      device_id bigint references devices(id) on delete set null,
      label text not null,
      node_type text not null default 'device',
      x numeric not null default 80,
      y numeric not null default 80,
      width numeric not null default 170,
      height numeric not null default 64,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (map_id, device_id)
    );
    create table if not exists topology_links (
      id bigserial primary key,
      map_id bigint not null references topology_maps(id) on delete cascade,
      source_node_id bigint not null references topology_nodes(id) on delete cascade,
      target_node_id bigint not null references topology_nodes(id) on delete cascade,
      source_interface_id bigint references device_interfaces(id) on delete set null,
      target_interface_id bigint references device_interfaces(id) on delete set null,
      label text,
      link_type text not null default 'manual',
      status text not null default 'unknown',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists device_neighbors (
      id bigserial primary key,
      device_id bigint not null references devices(id) on delete cascade,
      local_interface_id bigint references device_interfaces(id) on delete set null,
      local_if_index integer,
      local_port_id text,
      local_port_descr text,
      protocol text not null,
      fingerprint text not null,
      remote_chassis_id text,
      remote_device_name text,
      remote_port_id text,
      remote_port_descr text,
      remote_mgmt_address inet,
      remote_sys_name text,
      remote_sys_descr text,
      remote_device_id bigint references devices(id) on delete set null,
      remote_interface_id bigint references device_interfaces(id) on delete set null,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      stale boolean not null default false,
      raw jsonb not null default '{}'::jsonb
    );
    alter table topology_links add column if not exists discovery_protocol text;
    alter table topology_links add column if not exists neighbor_id bigint references device_neighbors(id) on delete set null;
    alter table topology_links add column if not exists auto_discovered boolean not null default false;
    alter table topology_links add column if not exists last_seen_at timestamptz;
    create unique index if not exists uq_topology_maps_default
      on topology_maps(is_default)
      where is_default = true;
    create index if not exists idx_topology_nodes_map_id
      on topology_nodes(map_id);
    create index if not exists idx_topology_nodes_device_id
      on topology_nodes(device_id);
    create index if not exists idx_topology_links_map_id
      on topology_links(map_id);
    create index if not exists idx_topology_links_source_target
      on topology_links(source_node_id, target_node_id);
    create unique index if not exists uq_device_neighbors_scope
      on device_neighbors(fingerprint);
    create index if not exists idx_device_neighbors_device_id
      on device_neighbors(device_id);
    create index if not exists idx_device_neighbors_remote_device_id
      on device_neighbors(remote_device_id);
    create index if not exists idx_device_neighbors_last_seen
      on device_neighbors(last_seen_at desc);
    create index if not exists idx_topology_links_neighbor_id
      on topology_links(neighbor_id);
    create unique index if not exists uq_topology_links_neighbor_id
      on topology_links(neighbor_id);
    insert into topology_maps (name, description, is_default)
    select '默认拓扑', '手动维护的默认网络拓扑', true
    where not exists (select 1 from topology_maps where is_default = true)
    on conflict (name) do nothing;
  `)

  app.addHook('onClose', async () => {
    await pool.end()
  })
})
