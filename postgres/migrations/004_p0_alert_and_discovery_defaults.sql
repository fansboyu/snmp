insert into alert_rules (name, rule_type, severity, metric_name, operator, threshold, duration_seconds, enabled)
values ('设备采集无数据', 'device_no_data', 'critical', null, null, null, 0, true)
on conflict (name) do nothing;
