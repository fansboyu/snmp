alter table topology_nodes add column if not exists position_locked boolean not null default false;
alter table topology_nodes add column if not exists layer text not null default 'access';
alter table topology_nodes add column if not exists identity_key text;
create unique index if not exists uq_topology_node_identity on topology_nodes(map_id,identity_key) where identity_key is not null;
alter table topology_links add column if not exists physical_key text;
alter table topology_links add column if not exists evidence_ids bigint[] not null default '{}';
alter table topology_links add column if not exists protocols text[] not null default '{}';
alter table topology_links add column if not exists binding_locked boolean not null default false;
alter table topology_links add column if not exists bundle_id bigint references topology_links(id) on delete set null;
create unique index if not exists uq_topology_link_physical on topology_links(map_id,physical_key) where physical_key is not null;
create table if not exists topology_scans (
 device_id bigint not null references devices(id) on delete cascade,
 protocol text not null,
 status text not null,
 reason text not null default '',
 checked_at timestamptz not null,
 last_success_at timestamptz,
 neighbor_count integer not null default 0,
 primary key(device_id,protocol)
);
create table if not exists topology_identities (
 device_id bigint not null references devices(id) on delete cascade,
 kind text not null,
 value text not null,
 updated_at timestamptz not null default now(),
 primary key(device_id,kind,value)
);
create table if not exists topology_neighbor_bindings (
 neighbor_id bigint primary key references device_neighbors(id) on delete cascade,
 remote_device_id bigint not null references devices(id) on delete cascade,
 remote_interface_id bigint references device_interfaces(id) on delete set null,
 updated_at timestamptz not null default now()
);
create table if not exists topology_suppressed_links (
 map_id bigint not null references topology_maps(id) on delete cascade,
 physical_key text not null,
 primary key(map_id,physical_key)
);
create table if not exists topology_changes (
 id bigserial primary key,
 map_id bigint not null references topology_maps(id) on delete cascade,
 entity_type text not null,
 entity_id bigint not null,
 action text not null,
 before_data jsonb,
 after_data jsonb,
 created_at timestamptz not null default now()
);
create index if not exists idx_topology_changes_map_time on topology_changes(map_id,created_at desc);
create or replace function record_topology_change() returns trigger language plpgsql as $$
declare previous jsonb; current_value jsonb;
begin
 if TG_OP <> 'INSERT' then previous=to_jsonb(OLD)-'updated_at'; end if;
 if TG_OP <> 'DELETE' then current_value=to_jsonb(NEW)-'updated_at'; end if;
 if (previous-'last_seen_at') is distinct from (current_value-'last_seen_at') and exists(select 1 from topology_maps where id=coalesce((current_value->>'map_id')::bigint,(previous->>'map_id')::bigint)) then
  insert into topology_changes(map_id,entity_type,entity_id,action,before_data,after_data)
  values(coalesce((current_value->>'map_id')::bigint,(previous->>'map_id')::bigint),TG_TABLE_NAME,coalesce((current_value->>'id')::bigint,(previous->>'id')::bigint),lower(TG_OP),previous,current_value);
 end if;
 return null;
end $$;
drop trigger if exists topology_node_audit on topology_nodes;
create trigger topology_node_audit after insert or update or delete on topology_nodes for each row execute function record_topology_change();
drop trigger if exists topology_link_audit on topology_links;
create trigger topology_link_audit after insert or update or delete on topology_links for each row execute function record_topology_change();
