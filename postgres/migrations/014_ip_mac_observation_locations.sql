-- Keep duplicate IP/MAC observations from distinct VLANs/interfaces on one device.
alter table ip_mac_observations
  drop constraint if exists ip_mac_observations_pkey;

alter table ip_mac_observations
  add constraint ip_mac_observations_pkey
  primary key (device_id, vlan_id, if_index, ip_address, mac_address);

create index if not exists idx_ip_mac_observations_correlation
  on ip_mac_observations (mac_address, ip_address, vlan_id) where active;
