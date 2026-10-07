create table if not exists email_notification_config (
  id integer primary key check (id = 1),
  config jsonb not null,
  updated_at timestamptz not null default now()
);
