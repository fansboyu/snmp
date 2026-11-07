alter table topology_maps add column if not exists root_node_id bigint references topology_nodes(id) on delete set null;
alter table topology_nodes add column if not exists asset_kind text not null default 'auto';
alter table topology_nodes add column if not exists asset_vendor text not null default '';
alter table topology_nodes add column if not exists asset_model text not null default '';
alter table topology_links add column if not exists lifecycle text not null default 'current' check(lifecycle in ('current','history'));
alter table topology_links add column if not exists retired_at timestamptz;
alter table topology_links add column if not exists retired_reason text not null default '';
