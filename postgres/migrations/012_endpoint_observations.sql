create table if not exists switch_mac_observations (
  device_id bigint not null references devices(id) on delete cascade,
  vlan_id integer not null default 0 check (vlan_id between 0 and 4094),
  mac_address text not null,
  if_index integer not null,
  active boolean not null default true,
  observed_at timestamptz not null,
  primary key (device_id, vlan_id, mac_address)
);
create index if not exists idx_switch_mac_observations_mac
  on switch_mac_observations (mac_address, vlan_id) where active;
create index if not exists idx_switch_mac_observations_port
  on switch_mac_observations (device_id, if_index, observed_at desc) where active;

create table if not exists ip_mac_observations (
  device_id bigint not null references devices(id) on delete cascade,
  vlan_id integer not null default 0 check (vlan_id between 0 and 4094),
  if_index integer not null,
  ip_address inet not null,
  mac_address text not null,
  active boolean not null default true,
  observed_at timestamptz not null,
  primary key (device_id, ip_address, mac_address)
);
create index if not exists idx_ip_mac_observations_mac
  on ip_mac_observations (mac_address, vlan_id) where active;
create index if not exists idx_ip_mac_observations_ip
  on ip_mac_observations (ip_address, observed_at desc) where active;
