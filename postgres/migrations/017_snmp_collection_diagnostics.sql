create table if not exists snmp_metric_scans (
  device_id bigint not null references devices(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  metric_name text not null,
  oid text not null,
  status text not null check (status in ('success','empty','unsupported','failed')),
  reason text not null default '',
  item_count integer not null default 0,
  checked_at timestamptz not null,
  last_success_at timestamptz,
  primary key (device_id, metric_id)
);
create index if not exists idx_snmp_metric_scans_status on snmp_metric_scans(status, checked_at desc);

create table if not exists device_interface_identity_changes (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  if_index integer not null,
  interface_id bigint references device_interfaces(id) on delete set null,
  old_if_name text not null default '',
  new_if_name text not null default '',
  old_if_descr text not null default '',
  new_if_descr text not null default '',
  detected_at timestamptz not null default now()
);
create index if not exists idx_interface_identity_changes_device_time
  on device_interface_identity_changes(device_id, detected_at desc);
