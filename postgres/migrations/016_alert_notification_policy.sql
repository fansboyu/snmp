-- A single failed SNMP cycle is not evidence that a device is offline.
update alert_rules
set enabled = false, updated_at = now()
where rule_type = 'device_no_data';

update alert_rules
set duration_seconds = 60, updated_at = now()
where rule_type in ('cpu_threshold', 'interface_down') and duration_seconds = 0;

alter table alert_events
  add column if not exists resolution_source text not null default 'condition';

insert into alert_rules (name, rule_type, severity, enabled)
values
  ('设备确认离线', 'device_offline', 'critical', true),
  ('设备采集异常', 'collection_error', 'warning', true)
on conflict (name) do nothing;

create table if not exists alert_rule_observations (
  rule_id bigint not null references alert_rules(id) on delete cascade,
  device_id bigint not null references devices(id) on delete cascade,
  interface_id bigint not null default 0,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  primary key (rule_id, device_id, interface_id)
);

create index if not exists idx_alert_rule_observations_last_seen
  on alert_rule_observations(last_observed_at);
