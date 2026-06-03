import fp from 'fastify-plugin'
import pg from 'pg'

export const dbPlugin = fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: app.config.DATABASE_URL
  })

  app.decorate('db', pool)
  await pool.query(`
    create table if not exists admin_users (
      id bigserial primary key,
      username text not null unique,
      display_name text not null default '系统管理员',
      password_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table alert_notifications add column if not exists subject text;
    alter table alert_notifications add column if not exists error text;
    alter table alert_notifications add column if not exists retry_count integer not null default 0;
    alter table alert_notifications add column if not exists next_retry_at timestamptz not null default now();
    alter table alert_notifications add column if not exists updated_at timestamptz not null default now();
    alter table metric_definitions add column if not exists aggregate_method text not null default 'latest';
    alter table metric_definitions add column if not exists display_group text;
    alter table metric_definitions add column if not exists vendor text;
    alter table oid_templates add column if not exists vendor text;
    alter table oid_templates add column if not exists device_type text;
    alter table metric_definitions add column if not exists display_name text;
    alter table metric_definitions add column if not exists description text;
    alter table metric_definitions add column if not exists value_type text not null default 'gauge';
    alter table metric_definitions add column if not exists scale numeric not null default 1;
    alter table metric_definitions add column if not exists precision integer not null default 2;
    alter table metric_definitions add column if not exists chartable boolean not null default true;
    alter table metric_definitions add column if not exists alertable boolean not null default false;
    alter table oid_template_definitions add column if not exists enabled boolean not null default true;
    alter table oid_template_definitions add column if not exists required boolean not null default false;
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
    insert into oid_templates (name, description, vendor, device_type)
    values ('华为 SNMP 模板', '华为交换机 CPU、内存、系统指标和接口表指标', 'huawei', 'switch')
    on conflict (name) do update set
      vendor = coalesce(oid_templates.vendor, excluded.vendor),
      device_type = coalesce(oid_templates.device_type, excluded.device_type);
    update oid_templates
    set vendor = coalesce(vendor, 'generic'),
      device_type = coalesce(device_type, 'switch')
    where name = '默认 SNMP 模板';
    insert into metric_definitions (
      name, oid, unit, display_name, description, metric_kind, table_oid, value_type, scale, precision,
      aggregate_method, display_group, vendor, chartable, alertable
    )
    values
      ('huaweiCpuUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', '%', '华为 CPU 使用率', '华为交换机 CPU 使用率 Walk 指标', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', 'gauge', 1, 0, 'max', 'cpu', 'huawei', true, true),
      ('huaweiMemoryUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', '%', '华为内存使用率', '华为交换机内存使用率 Walk 指标', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', 'gauge', 1, 0, 'max', 'memory', 'huawei', true, true)
    on conflict (oid) do update set
      display_name = excluded.display_name,
      description = excluded.description,
      metric_kind = excluded.metric_kind,
      table_oid = excluded.table_oid,
      value_type = excluded.value_type,
      scale = excluded.scale,
      precision = excluded.precision,
      aggregate_method = excluded.aggregate_method,
      display_group = excluded.display_group,
      vendor = excluded.vendor,
      chartable = excluded.chartable,
      alertable = excluded.alertable;
    update metric_definitions
    set display_name = case name
        when 'sysUpTime' then '系统运行时间'
        when 'ifNumber' then '接口数量'
        when 'cpuUsage' then 'CPU 使用率'
        when 'ifDescr' then '接口描述'
        when 'ifOperStatus' then '接口运行状态'
        when 'ifInOctets' then '接口入方向字节数'
        when 'ifOutOctets' then '接口出方向字节数'
        else coalesce(display_name, name)
      end,
      description = case name
        when 'sysUpTime' then 'SNMP sysUpTime 系统运行时间'
        when 'ifNumber' then 'SNMP ifNumber 接口数量'
        when 'cpuUsage' then 'HOST-RESOURCES-MIB CPU 使用率'
        when 'ifDescr' then 'SNMP ifDescr 接口描述'
        when 'ifOperStatus' then 'SNMP ifOperStatus 接口运行状态'
        when 'ifInOctets' then 'SNMP ifInOctets 接口入方向累计字节数'
        when 'ifOutOctets' then 'SNMP ifOutOctets 接口出方向累计字节数'
        else description
      end,
      value_type = case name
        when 'sysUpTime' then 'timeticks'
        when 'ifDescr' then 'string'
        when 'ifOperStatus' then 'status'
        when 'ifInOctets' then 'counter'
        when 'ifOutOctets' then 'counter'
        else coalesce(value_type, 'gauge')
      end,
      scale = coalesce(scale, 1),
      precision = case when name in ('sysUpTime', 'ifNumber', 'cpuUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets') then 0 else precision end,
      display_group = case name
        when 'sysUpTime' then 'system'
        when 'ifNumber' then 'system'
        when 'cpuUsage' then 'cpu'
        when 'ifDescr' then 'interface'
        when 'ifOperStatus' then 'interface'
        when 'ifInOctets' then 'interface'
        when 'ifOutOctets' then 'interface'
        else display_group
      end,
      vendor = coalesce(vendor, 'generic'),
      chartable = case when name in ('cpuUsage', 'ifOperStatus', 'ifInOctets', 'ifOutOctets') then true when name in ('sysUpTime', 'ifNumber', 'ifDescr') then false else chartable end,
      alertable = case when name in ('cpuUsage', 'ifOperStatus') then true when name in ('sysUpTime', 'ifNumber', 'ifDescr', 'ifInOctets', 'ifOutOctets') then false else alertable end
    where name in ('sysUpTime', 'ifNumber', 'cpuUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets');
    insert into oid_template_definitions (template_id, metric_id, sort_order)
    select t.id, m.id,
      case m.name
        when 'sysUpTime' then 10
        when 'ifNumber' then 20
        when 'huaweiCpuUsage' then 30
        when 'huaweiMemoryUsage' then 40
        when 'ifDescr' then 100
        when 'ifOperStatus' then 110
        when 'ifInOctets' then 120
        when 'ifOutOctets' then 130
        else 999
      end
    from oid_templates t
    join metric_definitions m on m.name in ('sysUpTime', 'ifNumber', 'huaweiCpuUsage', 'huaweiMemoryUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets')
    where t.name = '华为 SNMP 模板'
    on conflict (template_id, metric_id) do nothing;
    insert into oid_template_definitions (template_id, metric_id, sort_order)
    select t.id, m.id,
      case m.name
        when 'huaweiCpuUsage' then 40
        when 'huaweiMemoryUsage' then 50
        else 999
      end
    from oid_templates t
    join metric_definitions m on m.name in ('huaweiCpuUsage', 'huaweiMemoryUsage')
    where t.name = '默认 SNMP 模板'
    on conflict (template_id, metric_id) do nothing;
    update oid_template_definitions td
    set required = true
    from metric_definitions m
    where m.id = td.metric_id
      and m.name in ('cpuUsage', 'huaweiCpuUsage', 'huaweiMemoryUsage', 'ifOperStatus');
  `)

  app.addHook('onClose', async () => {
    await pool.end()
  })
})
