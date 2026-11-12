create table if not exists syslog_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  reported_at timestamptz,
  source_ip inet not null,
  hostname text,
  device_id bigint references devices(id) on delete set null,
  facility smallint check (facility between 0 and 23),
  severity smallint check (severity between 0 and 7),
  app_name text,
  procid text,
  msgid text,
  structured_data text,
  syslog_version smallint,
  parsed boolean not null default false,
  message text not null,
  raw_message text not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(message, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(hostname, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(app_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(msgid, '')), 'C')
  ) stored
);

create index if not exists idx_syslog_events_received_at
  on syslog_events(received_at desc);
create index if not exists idx_syslog_events_device_received
  on syslog_events(device_id, received_at desc);
create index if not exists idx_syslog_events_severity_received
  on syslog_events(severity, received_at desc);
create index if not exists idx_syslog_events_search_vector
  on syslog_events using gin(search_vector);

create table if not exists syslog_collector_status (
  id smallint primary key check (id = 1),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_received_at timestamptz,
  received_count bigint not null default 0,
  stored_count bigint not null default 0,
  dropped_count bigint not null default 0,
  last_error text,
  host_port integer not null default 514 check (host_port between 1 and 65535)
);
