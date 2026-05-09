create table if not exists devices (
  id bigserial primary key,
  name text not null,
  host inet not null,
  port integer not null default 161,
  community text,
  snmp_version text not null default '2c',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists metric_definitions (
  id bigserial primary key,
  name text not null,
  oid text not null unique,
  unit text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists metric_samples (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  value_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_devices_enabled on devices(enabled);
create index if not exists idx_metric_samples_device_time on metric_samples(device_id, created_at desc);
create index if not exists idx_metric_samples_metric_time on metric_samples(metric_id, created_at desc);

insert into metric_definitions (name, oid, unit)
values
  ('sysUpTime', '.1.3.6.1.2.1.1.3.0', 'ticks'),
  ('ifNumber', '.1.3.6.1.2.1.2.1.0', 'count')
on conflict (oid) do nothing;

