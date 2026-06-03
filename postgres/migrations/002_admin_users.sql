create table if not exists admin_users (
  id bigserial primary key,
  username text not null unique,
  display_name text not null default '系统管理员',
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
