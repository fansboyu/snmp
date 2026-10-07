alter table device_interfaces add column if not exists admin_status text;
alter table device_interfaces add column if not exists speed_bps bigint;
alter table device_interfaces add column if not exists user_note text not null default '';
create index if not exists idx_interface_samples_port_metric_time on interface_metric_samples(interface_id,metric_id,created_at desc);
insert into metric_definitions(name,oid,unit,display_name,metric_kind,table_oid,value_type,scale,precision,aggregate_method,display_group,vendor,chartable,alertable)
select name,oid,unit,label,'interface',oid,kind,1,0,'latest','interface','generic',false,false from (values
 ('ifName','.1.3.6.1.2.1.31.1.1.1.1','','端口名称','string'),
 ('ifAlias','.1.3.6.1.2.1.31.1.1.1.18','','设备端口备注','string'),
 ('ifAdminStatus','.1.3.6.1.2.1.2.2.1.7','','管理状态','status'),
 ('ifSpeed','.1.3.6.1.2.1.2.2.1.5','bps','端口速率','gauge'),
 ('ifHighSpeed','.1.3.6.1.2.1.31.1.1.1.15','Mbps','高速端口速率','gauge'),
 ('ifHCInOctets','.1.3.6.1.2.1.31.1.1.1.6','bytes','64 位入字节数','counter'),
 ('ifHCOutOctets','.1.3.6.1.2.1.31.1.1.1.10','bytes','64 位出字节数','counter'),
 ('ifCounterDiscontinuityTime','.1.3.6.1.2.1.31.1.1.1.19','ticks','计数器重置标识','timeticks'),
 ('ifInErrors','.1.3.6.1.2.1.2.2.1.14','count','入错误','counter'),
 ('ifOutErrors','.1.3.6.1.2.1.2.2.1.20','count','出错误','counter'),
 ('ifInDiscards','.1.3.6.1.2.1.2.2.1.13','count','入丢弃','counter'),
 ('ifOutDiscards','.1.3.6.1.2.1.2.2.1.19','count','出丢弃','counter')
) as x(name,oid,unit,label,kind) on conflict(oid) do nothing;
insert into oid_template_definitions(template_id,metric_id)
select t.id,m.id from oid_templates t cross join metric_definitions m
where t.name in ('默认 SNMP 模板','华为 SNMP 模板') and m.name in ('ifName','ifAlias','ifAdminStatus','ifSpeed','ifHighSpeed','ifHCInOctets','ifHCOutOctets','ifCounterDiscontinuityTime','ifInErrors','ifOutErrors','ifInDiscards','ifOutDiscards')
on conflict do nothing;
