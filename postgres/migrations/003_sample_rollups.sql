create table if not exists metric_sample_rollups (
  device_id bigint not null references devices(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  bucket_seconds integer not null,
  bucket_start timestamptz not null,
  min_value numeric,
  max_value numeric,
  avg_value numeric,
  last_value numeric,
  sample_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (device_id, metric_id, bucket_seconds, bucket_start)
);

create table if not exists interface_metric_sample_rollups (
  device_id bigint not null references devices(id) on delete cascade,
  interface_id bigint not null references device_interfaces(id) on delete cascade,
  metric_id bigint not null references metric_definitions(id) on delete cascade,
  bucket_seconds integer not null,
  bucket_start timestamptz not null,
  min_value numeric,
  max_value numeric,
  avg_value numeric,
  last_value numeric,
  sample_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (device_id, interface_id, metric_id, bucket_seconds, bucket_start)
);

create index if not exists idx_metric_rollups_bucket
  on metric_sample_rollups(bucket_seconds, bucket_start desc);
create index if not exists idx_metric_rollups_device_bucket
  on metric_sample_rollups(device_id, bucket_seconds, bucket_start desc);
create index if not exists idx_interface_rollups_bucket
  on interface_metric_sample_rollups(bucket_seconds, bucket_start desc);
create index if not exists idx_interface_rollups_device_bucket
  on interface_metric_sample_rollups(device_id, bucket_seconds, bucket_start desc);
create index if not exists idx_interface_rollups_interface_bucket
  on interface_metric_sample_rollups(interface_id, bucket_seconds, bucket_start desc);
