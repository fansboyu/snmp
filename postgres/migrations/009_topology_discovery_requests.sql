create table if not exists topology_scan_requests (
 id bigserial primary key,
 device_id bigint not null references devices(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','running','completed','failed')),
 reason text not null default '',
 created_at timestamptz not null default now(),
 started_at timestamptz,
 finished_at timestamptz
);
create unique index if not exists uq_topology_request_active on topology_scan_requests(device_id) where status in ('pending','running');
create index if not exists idx_topology_request_pending on topology_scan_requests(status,id);
