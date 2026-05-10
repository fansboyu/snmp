insert into devices (name, host, port, community, enabled, group_id)
select device.name, device.host::inet, device.port, device.community, device.enabled, g.id
from (
  values
    ('Demo Router', '127.0.0.1', 161, 'public', false),
    ('Core Switch 01', '192.0.2.10', 161, 'public', false),
    ('Edge Switch 01', '192.0.2.11', 161, 'public', false)
) as device(name, host, port, community, enabled)
left join device_groups g on g.name = '默认分组'
on conflict do nothing;

insert into metric_samples (device_id, metric_id, value_text, created_at)
select d.id, m.id, sample.value_text, sample.created_at
from (
  values
    ('Demo Router', 'sysUpTime', '123456', now() - interval '5 minutes'),
    ('Demo Router', 'ifNumber', '24', now() - interval '5 minutes'),
    ('Demo Router', 'cpuUsage', '31', now() - interval '25 minutes'),
    ('Demo Router', 'cpuUsage', '42', now() - interval '20 minutes'),
    ('Demo Router', 'cpuUsage', '37', now() - interval '15 minutes'),
    ('Demo Router', 'cpuUsage', '48', now() - interval '10 minutes'),
    ('Demo Router', 'cpuUsage', '35', now() - interval '5 minutes'),
    ('Core Switch 01', 'sysUpTime', '987654', now() - interval '4 minutes'),
    ('Core Switch 01', 'ifNumber', '48', now() - interval '4 minutes'),
    ('Core Switch 01', 'cpuUsage', '55', now() - interval '20 minutes'),
    ('Core Switch 01', 'cpuUsage', '61', now() - interval '15 minutes'),
    ('Core Switch 01', 'cpuUsage', '58', now() - interval '10 minutes'),
    ('Core Switch 01', 'cpuUsage', '52', now() - interval '4 minutes'),
    ('Edge Switch 01', 'sysUpTime', '654321', now() - interval '3 minutes'),
    ('Edge Switch 01', 'ifNumber', '24', now() - interval '3 minutes'),
    ('Edge Switch 01', 'cpuUsage', '28', now() - interval '18 minutes'),
    ('Edge Switch 01', 'cpuUsage', '33', now() - interval '12 minutes'),
    ('Edge Switch 01', 'cpuUsage', '29', now() - interval '3 minutes')
) as sample(device_name, metric_name, value_text, created_at)
join devices d on d.name = sample.device_name
join metric_definitions m on m.name = sample.metric_name;

insert into device_interfaces (device_id, if_index, if_descr, if_name, oper_status, last_seen_at)
select d.id, iface.if_index, iface.if_descr, iface.if_name, iface.oper_status, now() - interval '2 minutes'
from (
  values
    ('Demo Router', 1, 'GigabitEthernet0/0', 'Gi0/0', '1'),
    ('Demo Router', 2, 'GigabitEthernet0/1', 'Gi0/1', '1'),
    ('Core Switch 01', 1, 'TenGigabitEthernet1/0/1', 'Te1/0/1', '1'),
    ('Core Switch 01', 2, 'TenGigabitEthernet1/0/2', 'Te1/0/2', '2'),
    ('Edge Switch 01', 1, 'GigabitEthernet1/0/1', 'Gi1/0/1', '1')
) as iface(device_name, if_index, if_descr, if_name, oper_status)
join devices d on d.name = iface.device_name
on conflict (device_id, if_index)
do update set
  if_descr = excluded.if_descr,
  if_name = excluded.if_name,
  oper_status = excluded.oper_status,
  last_seen_at = excluded.last_seen_at,
  updated_at = now();

insert into interface_metric_samples (device_id, interface_id, metric_id, value_text, created_at)
select i.device_id, i.id, m.id, sample.value_text, sample.created_at
from (
  values
    ('Demo Router', 1, 'ifInOctets', '120000000', now() - interval '20 minutes'),
    ('Demo Router', 1, 'ifInOctets', '138000000', now() - interval '15 minutes'),
    ('Demo Router', 1, 'ifInOctets', '166000000', now() - interval '10 minutes'),
    ('Demo Router', 1, 'ifInOctets', '188000000', now() - interval '5 minutes'),
    ('Demo Router', 1, 'ifOutOctets', '90000000', now() - interval '20 minutes'),
    ('Demo Router', 1, 'ifOutOctets', '112000000', now() - interval '15 minutes'),
    ('Demo Router', 1, 'ifOutOctets', '131000000', now() - interval '10 minutes'),
    ('Demo Router', 1, 'ifOutOctets', '161000000', now() - interval '5 minutes'),
    ('Core Switch 01', 1, 'ifInOctets', '220000000', now() - interval '20 minutes'),
    ('Core Switch 01', 1, 'ifInOctets', '290000000', now() - interval '15 minutes'),
    ('Core Switch 01', 1, 'ifInOctets', '345000000', now() - interval '10 minutes'),
    ('Core Switch 01', 1, 'ifInOctets', '420000000', now() - interval '5 minutes'),
    ('Core Switch 01', 1, 'ifOutOctets', '180000000', now() - interval '20 minutes'),
    ('Core Switch 01', 1, 'ifOutOctets', '235000000', now() - interval '15 minutes'),
    ('Core Switch 01', 1, 'ifOutOctets', '285000000', now() - interval '10 minutes'),
    ('Core Switch 01', 1, 'ifOutOctets', '330000000', now() - interval '5 minutes')
) as sample(device_name, if_index, metric_name, value_text, created_at)
join devices d on d.name = sample.device_name
join device_interfaces i on i.device_id = d.id and i.if_index = sample.if_index
join metric_definitions m on m.name = sample.metric_name;

insert into alert_events (rule_id, device_id, interface_id, severity, status, title, message, value_text, triggered_at, last_seen_at)
select r.id, d.id, i.id, r.severity, 'active',
  '接口状态 Down',
  d.name || ' ' || coalesce(i.if_name, i.if_descr, i.if_index::text) || ' 接口处于 Down 状态',
  '2',
  now() - interval '2 minutes',
  now() - interval '2 minutes'
from alert_rules r
join devices d on d.name = 'Core Switch 01'
join device_interfaces i on i.device_id = d.id and i.if_index = 2
where r.rule_type = 'interface_down'
on conflict do nothing;
