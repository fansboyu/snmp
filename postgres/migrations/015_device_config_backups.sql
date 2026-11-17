create table if not exists device_config_backup_profiles (
  device_id bigint primary key references devices(id) on delete cascade,
  protocol text not null default 'ssh' check (protocol in ('ssh','netconf')),
  platform text not null check (platform in ('cisco_ios','huawei_vrp','h3c_comware')),
  port integer not null default 22 check (port between 1 and 65535),
  username text not null,
  auth_mode text not null default 'password' check (auth_mode in ('password','private_key')),
  credential_ciphertext text not null,
  host_key_fingerprint text not null,
  enabled boolean not null default false,
  interval_hours integer not null default 24 check (interval_hours between 1 and 720),
  retention_count integer not null default 30 check (retention_count between 2 and 365),
  next_backup_at timestamptz not null default now(),
  last_backup_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists device_config_backup_jobs (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('manual','scheduled')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  requested_by text,
  requested_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  attempts smallint not null default 0 check (attempts between 0 and 3),
  version_id bigint,
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_device_config_backup_active_job
  on device_config_backup_jobs(device_id) where status in ('queued','running');
create index if not exists idx_device_config_backup_jobs_recent
  on device_config_backup_jobs(device_id, requested_at desc);
create index if not exists idx_device_config_backup_jobs_queue
  on device_config_backup_jobs(status, requested_at) where status='queued';

create table if not exists device_config_backup_versions (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  job_id bigint not null unique references device_config_backup_jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  sha256 text not null,
  encrypted_content text not null,
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  baseline boolean not null default false,
  changed boolean not null,
  previous_version_id bigint references device_config_backup_versions(id) on delete set null
);
create index if not exists idx_device_config_backup_versions_device
  on device_config_backup_versions(device_id, created_at desc);

alter table device_config_backup_jobs
  add constraint fk_device_config_backup_job_version
  foreign key (version_id) references device_config_backup_versions(id) on delete set null;

create table if not exists device_config_backup_audit (
  id bigserial primary key,
  device_id bigint not null references devices(id) on delete cascade,
  version_id bigint references device_config_backup_versions(id) on delete set null,
  action text not null check (action in ('view_diff','download')),
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_device_config_backup_audit_recent
  on device_config_backup_audit(device_id, created_at desc);
