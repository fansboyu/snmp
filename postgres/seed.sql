insert into devices (name, host, port, community, enabled)
values
  ('Demo Router', '127.0.0.1', 161, 'public', false),
  ('Core Switch 01', '192.0.2.10', 161, 'public', false),
  ('Edge Switch 01', '192.0.2.11', 161, 'public', false)
on conflict do nothing;

insert into metric_samples (device_id, metric_id, value_text, created_at)
select d.id, m.id, sample.value_text, sample.created_at
from (
  values
    ('Demo Router', 'sysUpTime', '123456', now() - interval '5 minutes'),
    ('Demo Router', 'ifNumber', '24', now() - interval '5 minutes'),
    ('Core Switch 01', 'sysUpTime', '987654', now() - interval '4 minutes'),
    ('Core Switch 01', 'ifNumber', '48', now() - interval '4 minutes'),
    ('Edge Switch 01', 'sysUpTime', '654321', now() - interval '3 minutes'),
    ('Edge Switch 01', 'ifNumber', '24', now() - interval '3 minutes')
) as sample(device_name, metric_name, value_text, created_at)
join devices d on d.name = sample.device_name
join metric_definitions m on m.name = sample.metric_name;
