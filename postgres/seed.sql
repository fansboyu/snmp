truncate table
  alert_notifications,
  alert_events,
  interface_metric_samples,
  device_interfaces,
  metric_samples,
  devices
restart identity cascade;

insert into devices (
  name,
  host,
  port,
  community,
  snmp_version,
  enabled,
  group_id
)
select device.name, device.host::inet, device.port, device.community, '2c', true, g.id
from (
  values
    ('Lab SNMPv2 Router', '172.28.0.11', 161, 'public'),
    ('Lab SNMPv2 Switch', '172.28.0.12', 161, 'public')
) as device(name, host, port, community)
left join device_groups g on g.name = '默认分组';

insert into devices (
  name,
  host,
  port,
  community,
  snmp_version,
  snmp_v3_username,
  snmp_v3_security_level,
  snmp_v3_auth_protocol,
  snmp_v3_auth_passphrase,
  snmp_v3_priv_protocol,
  snmp_v3_priv_passphrase,
  enabled,
  group_id
)
select
  'Lab SNMPv3 Router',
  '172.28.0.13'::inet,
  161,
  'public',
  '3',
  'monitor',
  'authPriv',
  'SHA256',
  'auth-password',
  'AES',
  'priv-password',
  true,
  g.id
from device_groups g
where g.name = '默认分组'
limit 1;

insert into alert_rules (name, rule_type, severity, metric_name, operator, threshold, duration_seconds, enabled)
values
  ('CPU 使用率超过 80%', 'cpu_threshold', 'warning', 'cpuUsage', '>', 80, 0, true),
  ('接口状态 Down', 'interface_down', 'critical', 'ifOperStatus', '=', 2, 0, true)
on conflict (name) do update set
  rule_type = excluded.rule_type,
  severity = excluded.severity,
  metric_name = excluded.metric_name,
  operator = excluded.operator,
  threshold = excluded.threshold,
  duration_seconds = excluded.duration_seconds,
  enabled = excluded.enabled,
  updated_at = now();
