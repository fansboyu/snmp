create table if not exists wecom_app_notification_config (
  id integer primary key check (id = 1),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_alert_notifications_wecom_pending
  on alert_notifications (status, next_retry_at, created_at)
  where channel = 'wecom_app';
