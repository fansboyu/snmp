create table if not exists oid_templates (
  id bigserial primary key,
  name text not null unique,
  description text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists device_groups (
  id bigserial primary key,
  name text not null unique,
  description text,
  template_id bigint references oid_templates(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists devices (
  id bigserial primary key,
  name text not null,
  host inet not null,
  port integer not null default 161,
  group_id bigint references device_groups(id) on delete set null,
  community text,
  snmp_version text not null default '2c',
  snmp_v3_username text,
  snmp_v3_security_level text not null default 'noAuthNoPriv',
  snmp_v3_auth_protocol text,
  snmp_v3_auth_passphrase text,
  snmp_v3_priv_protocol text,
  snmp_v3_priv_passphrase text,
  snmp_v3_context_name text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists metric_definitions (
  id bigserial primary key,
  name text not null,
  oid text not null unique,
  unit text,
  metric_kind text not null default 'scalar',
  table_oid text,
  aggregate_method text not null default 'latest',
  display_group text,
  vendor text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists oid_template_definitions (
  template_id bigint not null references oid_templates(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (template_id, metric_id)
);

create table if not exists metric_samples (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  value_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists device_interfaces (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  if_index integer not null,
  if_descr text,
  if_name text,
  if_alias text,
  oper_status text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, if_index)
);

create table if not exists interface_metric_samples (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  interface_id bigint not null references device_interfaces(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  value_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists alert_rules (
  id bigserial primary key,
  name text not null,
  rule_type text not null,
  severity text not null default 'warning',
  device_id bigint references devices(id) on delete cascade,
  interface_id bigint references device_interfaces(id) on delete cascade,
  metric_name text,
  operator text,
  threshold numeric,
  duration_seconds integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists alert_events (
  id bigserial primary key,
  rule_id bigint references alert_rules(id) on delete set null,
  device_id bigint references devices(id) on delete cascade,
  interface_id bigint references device_interfaces(id) on delete cascade,
  severity text not null,
  status text not null default 'active',
  title text not null,
  message text,
  value_text text,
  triggered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists alert_notifications (
  id bigserial primary key,
  event_id bigint not null references alert_events(id) on delete cascade,
  channel text not null default 'web',
  target text,
  status text not null default 'pending',
  subject text,
  message text,
  error text,
  retry_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);

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

alter table devices add column if not exists group_id bigint references device_groups(id) on delete set null;
alter table devices add column if not exists snmp_version text not null default '2c';
alter table devices add column if not exists snmp_v3_username text;
alter table devices add column if not exists snmp_v3_security_level text not null default 'noAuthNoPriv';
alter table devices add column if not exists snmp_v3_auth_protocol text;
alter table devices add column if not exists snmp_v3_auth_passphrase text;
alter table devices add column if not exists snmp_v3_priv_protocol text;
alter table devices add column if not exists snmp_v3_priv_passphrase text;
alter table devices add column if not exists snmp_v3_context_name text;
alter table metric_definitions add column if not exists metric_kind text not null default 'scalar';
alter table metric_definitions add column if not exists table_oid text;
alter table metric_definitions add column if not exists aggregate_method text not null default 'latest';
alter table metric_definitions add column if not exists display_group text;
alter table metric_definitions add column if not exists vendor text;
alter table alert_notifications add column if not exists subject text;
alter table alert_notifications add column if not exists error text;
alter table alert_notifications add column if not exists retry_count integer not null default 0;
alter table alert_notifications add column if not exists next_retry_at timestamptz not null default now();
alter table alert_notifications add column if not exists updated_at timestamptz not null default now();
alter table topology_links add column if not exists discovery_protocol text;
alter table topology_links add column if not exists neighbor_id bigint references device_neighbors(id) on delete set null;
alter table topology_links add column if not exists auto_discovered boolean not null default false;
alter table topology_links add column if not exists last_seen_at timestamptz;

create index if not exists idx_devices_enabled on devices(enabled);
create index if not exists idx_devices_group_id on devices(group_id);
create index if not exists idx_device_groups_template_id on device_groups(template_id);
create index if not exists idx_metric_samples_device_time on metric_samples(device_id, created_at desc);
create index if not exists idx_metric_samples_metric_time on metric_samples(metric_id, created_at desc);
create index if not exists idx_metric_samples_created_at on metric_samples(created_at);
create index if not exists idx_device_interfaces_device_id on device_interfaces(device_id);
create index if not exists idx_interface_samples_device_time on interface_metric_samples(device_id, created_at desc);
create index if not exists idx_interface_samples_interface_time on interface_metric_samples(interface_id, created_at desc);
create index if not exists idx_interface_samples_created_at on interface_metric_samples(created_at);
create index if not exists idx_alert_rules_enabled on alert_rules(enabled);
create unique index if not exists uq_alert_rules_name on alert_rules(name);
create index if not exists idx_alert_events_status_time on alert_events(status, triggered_at desc);
create index if not exists idx_alert_events_device_time on alert_events(device_id, triggered_at desc);
create index if not exists idx_alert_events_resolved_cleanup
  on alert_events(status, coalesce(resolved_at, last_seen_at, triggered_at));
create unique index if not exists uq_alert_events_active_scope
  on alert_events (
    coalesce(rule_id, 0),
    coalesce(device_id, 0),
    coalesce(interface_id, 0),
    title
  )
  where status = 'active';
create index if not exists idx_alert_notifications_pending
  on alert_notifications(status, next_retry_at);
create unique index if not exists uq_alert_notifications_event_channel_target_subject
  on alert_notifications(event_id, channel, target, subject);
create index if not exists idx_discovery_jobs_status_created
  on discovery_jobs(status, created_at desc);
create index if not exists idx_discovery_results_job_id
  on discovery_results(job_id);
create index if not exists idx_discovery_results_host
  on discovery_results(host);
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

insert into oid_templates (name, description)
values ('默认 SNMP 模板', '内置系统指标和接口表指标')
on conflict (name) do nothing;

insert into oid_templates (name, description)
values ('华为 SNMP 模板', '华为交换机 CPU、内存、系统指标和接口表指标')
on conflict (name) do nothing;

insert into device_groups (name, description, template_id)
select '默认分组', '默认设备分组', id
from oid_templates
where name = '默认 SNMP 模板'
on conflict (name) do nothing;

insert into metric_definitions (name, oid, unit, metric_kind, table_oid, aggregate_method, display_group, vendor)
values
  ('sysUpTime', '.1.3.6.1.2.1.1.3.0', 'ticks', 'scalar', null, 'latest', 'system', 'generic'),
  ('ifNumber', '.1.3.6.1.2.1.2.1.0', 'count', 'scalar', null, 'latest', 'system', 'generic'),
  ('cpuUsage', '.1.3.6.1.2.1.25.3.3.1.2.196608', '%', 'scalar', null, 'latest', 'cpu', 'generic'),
  ('huaweiCpuUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', '%', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', 'max', 'cpu', 'huawei'),
  ('huaweiMemoryUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', '%', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', 'max', 'memory', 'huawei'),
  ('ifDescr', '.1.3.6.1.2.1.2.2.1.2', '', 'interface', '.1.3.6.1.2.1.2.2.1.2', 'latest', 'interface', 'generic'),
  ('ifOperStatus', '.1.3.6.1.2.1.2.2.1.8', '', 'interface', '.1.3.6.1.2.1.2.2.1.8', 'latest', 'interface', 'generic'),
  ('ifInOctets', '.1.3.6.1.2.1.2.2.1.10', 'bytes', 'interface', '.1.3.6.1.2.1.2.2.1.10', 'latest', 'interface', 'generic'),
  ('ifOutOctets', '.1.3.6.1.2.1.2.2.1.16', 'bytes', 'interface', '.1.3.6.1.2.1.2.2.1.16', 'latest', 'interface', 'generic')
on conflict (oid) do nothing;

insert into oid_template_definitions (template_id, metric_id, sort_order)
select t.id, m.id,
  case m.name
    when 'sysUpTime' then 10
    when 'ifNumber' then 20
    when 'cpuUsage' then 30
    when 'huaweiCpuUsage' then 40
    when 'huaweiMemoryUsage' then 50
    when 'ifDescr' then 100
    when 'ifOperStatus' then 110
    when 'ifInOctets' then 120
    when 'ifOutOctets' then 130
    else 999
  end
from oid_templates t
join metric_definitions m on m.name in ('sysUpTime', 'ifNumber', 'cpuUsage', 'huaweiCpuUsage', 'huaweiMemoryUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets')
where t.name = '默认 SNMP 模板'
on conflict (template_id, metric_id) do nothing;

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

insert into alert_rules (name, rule_type, severity, metric_name, operator, threshold, duration_seconds, enabled)
values
  ('CPU 使用率超过 80%', 'cpu_threshold', 'warning', 'cpuUsage', '>', 80, 0, true),
  ('接口状态 Down', 'interface_down', 'critical', 'ifOperStatus', '=', 2, 0, true)
on conflict (name) do nothing;

insert into topology_maps (name, description, is_default)
values ('默认拓扑', '手动维护的默认网络拓扑', true)
on conflict (name) do nothing;
