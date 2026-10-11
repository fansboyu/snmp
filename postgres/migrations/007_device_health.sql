create table if not exists device_health (
  device_id bigint primary key references devices(id) on delete cascade,
  checked_at timestamptz not null,
  status text not null check (status in ('checking','offline','collection_error','unknown')),
  consecutive_failures integer not null default 0,
  first_failed_at timestamptz,
  reason text not null default '',
  snmp_ok boolean not null default false,
  ping_ok boolean not null default false
);
