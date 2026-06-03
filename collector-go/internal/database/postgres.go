package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"snmp-monitor/collector-go/internal/collector"
	"snmp-monitor/collector-go/internal/discovery"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
}

func Connect(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	pool, err := pgxpool.Connect(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	if err := ensureRuntimeSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return &PostgresStore{pool: pool}, nil
}

func (store *PostgresStore) Close() {
	store.pool.Close()
}

func (store *PostgresStore) ResetStaleDiscoveryJobs(ctx context.Context, staleAfter time.Duration) error {
	_, err := store.pool.Exec(ctx, `
		update discovery_jobs
		set status = 'failed',
			error_message = 'discovery worker stopped before finishing the job',
			finished_at = now(),
			updated_at = now()
		where status = 'running'
			and updated_at < now() - make_interval(secs => $1)
	`, int(staleAfter.Seconds()))
	return err
}

func (store *PostgresStore) ClaimDiscoveryJob(ctx context.Context) (*discovery.Job, error) {
	var job discovery.Job
	err := store.pool.QueryRow(ctx, `
		with picked as (
			select id
			from discovery_jobs
			where status = 'pending'
			order by created_at
			limit 1
			for update skip locked
		)
		update discovery_jobs j
		set status = 'running',
			started_at = coalesce(started_at, now()),
			finished_at = null,
			error_message = null,
			updated_at = now()
		from picked
		where j.id = picked.id
		returning
			j.id,
			j.cidr,
			j.port,
			j.snmp_version,
			coalesce(j.community, ''),
			j.timeout_ms,
			j.retries,
			j.concurrency,
			j.total_hosts,
			j.scanned_hosts,
			j.discovered_hosts,
			j.status
	`).Scan(
		&job.ID,
		&job.CIDR,
		&job.Port,
		&job.SNMPVersion,
		&job.Community,
		&job.TimeoutMS,
		&job.Retries,
		&job.Concurrency,
		&job.TotalHosts,
		&job.ScannedHosts,
		&job.DiscoveredHosts,
		&job.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (store *PostgresStore) SetDiscoveryJobTotal(ctx context.Context, id int64, total int) error {
	_, err := store.pool.Exec(ctx, `
		update discovery_jobs
		set total_hosts = $2,
			updated_at = now()
		where id = $1
	`, id, total)
	return err
}

func (store *PostgresStore) SaveDiscoveryResult(ctx context.Context, result discovery.Result) error {
	_, err := store.pool.Exec(ctx, `
		insert into discovery_results (
			job_id,
			host,
			port,
			snmp_version,
			sys_name,
			sys_descr,
			sys_object_id,
			response_ms,
			status,
			error_message,
			discovered_at
		)
		values ($1, $2::inet, $3, $4, nullif($5, ''), nullif($6, ''), nullif($7, ''), $8, $9, nullif($10, ''), now())
		on conflict (job_id, host, port)
		do update set
			sys_name = excluded.sys_name,
			sys_descr = excluded.sys_descr,
			sys_object_id = excluded.sys_object_id,
			response_ms = excluded.response_ms,
			status = case when discovery_results.device_id is null then excluded.status else discovery_results.status end,
			error_message = excluded.error_message,
			discovered_at = now()
	`, result.JobID, result.Host, result.Port, result.SNMPVersion, result.SysName, result.SysDescr, result.SysObjectID, result.ResponseMS, result.Status, result.Error)
	return err
}

func (store *PostgresStore) IncrementDiscoveryProgress(ctx context.Context, id int64, discoveredDelta int) (string, error) {
	var status string
	err := store.pool.QueryRow(ctx, `
		update discovery_jobs
		set scanned_hosts = scanned_hosts + 1,
			discovered_hosts = discovered_hosts + $2,
			updated_at = now()
		where id = $1
		returning status
	`, id, discoveredDelta).Scan(&status)
	return status, err
}

func (store *PostgresStore) FinishDiscoveryJob(ctx context.Context, id int64, status string, message string) error {
	_, err := store.pool.Exec(ctx, `
		update discovery_jobs
		set status = $2,
			error_message = nullif($3, ''),
			finished_at = now(),
			updated_at = now()
		where id = $1 and status <> 'canceled'
	`, id, status, message)
	return err
}

func ensureRuntimeSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		alter table alert_notifications add column if not exists subject text;
		alter table alert_notifications add column if not exists error text;
		alter table alert_notifications add column if not exists retry_count integer not null default 0;
		alter table alert_notifications add column if not exists next_retry_at timestamptz not null default now();
		alter table alert_notifications add column if not exists updated_at timestamptz not null default now();
		alter table metric_definitions add column if not exists aggregate_method text not null default 'latest';
		alter table metric_definitions add column if not exists display_group text;
		alter table metric_definitions add column if not exists vendor text;
		alter table oid_templates add column if not exists vendor text;
		alter table oid_templates add column if not exists device_type text;
		alter table metric_definitions add column if not exists display_name text;
		alter table metric_definitions add column if not exists description text;
		alter table metric_definitions add column if not exists value_type text not null default 'gauge';
		alter table metric_definitions add column if not exists scale numeric not null default 1;
		alter table metric_definitions add column if not exists precision integer not null default 2;
		alter table metric_definitions add column if not exists chartable boolean not null default true;
		alter table metric_definitions add column if not exists alertable boolean not null default false;
		alter table oid_template_definitions add column if not exists enabled boolean not null default true;
		alter table oid_template_definitions add column if not exists required boolean not null default false;
		create table if not exists device_neighbors (
			id bigserial primary key,
			device_id bigint not null references devices(id) on delete cascade,
			local_interface_id bigint references device_interfaces(id) on delete set null,
			local_if_index integer,
			local_port_id text,
			local_port_descr text,
			protocol text not null,
			fingerprint text not null,
			remote_chassis_id text,
			remote_device_name text,
			remote_port_id text,
			remote_port_descr text,
			remote_mgmt_address inet,
			remote_sys_name text,
			remote_sys_descr text,
			remote_device_id bigint references devices(id) on delete set null,
			remote_interface_id bigint references device_interfaces(id) on delete set null,
			first_seen_at timestamptz not null default now(),
			last_seen_at timestamptz not null default now(),
			updated_at timestamptz not null default now(),
			stale boolean not null default false,
			raw jsonb not null default '{}'::jsonb
		);
		create index if not exists idx_alert_notifications_pending
			on alert_notifications(status, next_retry_at);
		create unique index if not exists uq_alert_notifications_event_channel_target_subject
			on alert_notifications(event_id, channel, target, subject);
		create table if not exists discovery_jobs (
			id bigserial primary key,
			cidr text not null,
			port integer not null default 161,
			snmp_version text not null default '2c',
			community text,
			timeout_ms integer not null default 1000,
			retries integer not null default 0,
			concurrency integer not null default 16,
			status text not null default 'pending',
			total_hosts integer not null default 0,
			scanned_hosts integer not null default 0,
			discovered_hosts integer not null default 0,
			error_message text,
			started_at timestamptz,
			finished_at timestamptz,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		);
		create table if not exists discovery_results (
			id bigserial primary key,
			job_id bigint not null references discovery_jobs(id) on delete cascade,
			host inet not null,
			port integer not null default 161,
			snmp_version text not null default '2c',
			sys_name text,
			sys_descr text,
			sys_object_id text,
			response_ms integer,
			status text not null default 'discovered',
			device_id bigint references devices(id) on delete set null,
			error_message text,
			discovered_at timestamptz not null default now(),
			imported_at timestamptz,
			unique (job_id, host, port)
		);
		create index if not exists idx_discovery_jobs_status_created
			on discovery_jobs(status, created_at desc);
		create index if not exists idx_discovery_results_job_id
			on discovery_results(job_id);
		create index if not exists idx_discovery_results_host
			on discovery_results(host);
		alter table topology_links add column if not exists discovery_protocol text;
		alter table topology_links add column if not exists neighbor_id bigint references device_neighbors(id) on delete set null;
		alter table topology_links add column if not exists auto_discovered boolean not null default false;
		alter table topology_links add column if not exists last_seen_at timestamptz;
		create unique index if not exists uq_device_neighbors_scope on device_neighbors(fingerprint);
		create index if not exists idx_device_neighbors_device_id on device_neighbors(device_id);
		create index if not exists idx_device_neighbors_remote_device_id on device_neighbors(remote_device_id);
		create index if not exists idx_device_neighbors_last_seen on device_neighbors(last_seen_at desc);
		create index if not exists idx_topology_links_neighbor_id on topology_links(neighbor_id);
		create unique index if not exists uq_topology_links_neighbor_id on topology_links(neighbor_id);
		insert into oid_templates (name, description, vendor, device_type)
		values ('华为 SNMP 模板', '华为交换机 CPU、内存、系统指标和接口表指标', 'huawei', 'switch')
		on conflict (name) do update set
		  vendor = coalesce(oid_templates.vendor, excluded.vendor),
		  device_type = coalesce(oid_templates.device_type, excluded.device_type);
		update oid_templates
		set vendor = coalesce(vendor, 'generic'),
		  device_type = coalesce(device_type, 'switch')
		where name = '默认 SNMP 模板';
		insert into metric_definitions (
		  name, oid, unit, display_name, description, metric_kind, table_oid, value_type, scale, precision,
		  aggregate_method, display_group, vendor, chartable, alertable
		)
		values
		  ('huaweiCpuUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', '%', '华为 CPU 使用率', '华为交换机 CPU 使用率 Walk 指标', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5', 'gauge', 1, 0, 'max', 'cpu', 'huawei', true, true),
		  ('huaweiMemoryUsage', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', '%', '华为内存使用率', '华为交换机内存使用率 Walk 指标', 'walk', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7', 'gauge', 1, 0, 'max', 'memory', 'huawei', true, true)
		on conflict (oid) do update set
		  display_name = excluded.display_name,
		  description = excluded.description,
		  metric_kind = excluded.metric_kind,
		  table_oid = excluded.table_oid,
		  value_type = excluded.value_type,
		  scale = excluded.scale,
		  precision = excluded.precision,
		  aggregate_method = excluded.aggregate_method,
		  display_group = excluded.display_group,
		  vendor = excluded.vendor,
		  chartable = excluded.chartable,
		  alertable = excluded.alertable;
		update metric_definitions
		set display_name = case name
		    when 'sysUpTime' then '系统运行时间'
		    when 'ifNumber' then '接口数量'
		    when 'cpuUsage' then 'CPU 使用率'
		    when 'ifDescr' then '接口描述'
		    when 'ifOperStatus' then '接口运行状态'
		    when 'ifInOctets' then '接口入方向字节数'
		    when 'ifOutOctets' then '接口出方向字节数'
		    else coalesce(display_name, name)
		  end,
		  description = case name
		    when 'sysUpTime' then 'SNMP sysUpTime 系统运行时间'
		    when 'ifNumber' then 'SNMP ifNumber 接口数量'
		    when 'cpuUsage' then 'HOST-RESOURCES-MIB CPU 使用率'
		    when 'ifDescr' then 'SNMP ifDescr 接口描述'
		    when 'ifOperStatus' then 'SNMP ifOperStatus 接口运行状态'
		    when 'ifInOctets' then 'SNMP ifInOctets 接口入方向累计字节数'
		    when 'ifOutOctets' then 'SNMP ifOutOctets 接口出方向累计字节数'
		    else description
		  end,
		  value_type = case name
		    when 'sysUpTime' then 'timeticks'
		    when 'ifDescr' then 'string'
		    when 'ifOperStatus' then 'status'
		    when 'ifInOctets' then 'counter'
		    when 'ifOutOctets' then 'counter'
		    else coalesce(value_type, 'gauge')
		  end,
		  scale = coalesce(scale, 1),
		  precision = case when name in ('sysUpTime', 'ifNumber', 'cpuUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets') then 0 else precision end,
		  display_group = case name
		    when 'sysUpTime' then 'system'
		    when 'ifNumber' then 'system'
		    when 'cpuUsage' then 'cpu'
		    when 'ifDescr' then 'interface'
		    when 'ifOperStatus' then 'interface'
		    when 'ifInOctets' then 'interface'
		    when 'ifOutOctets' then 'interface'
		    else display_group
		  end,
		  vendor = coalesce(vendor, 'generic'),
		  chartable = case when name in ('cpuUsage', 'ifOperStatus', 'ifInOctets', 'ifOutOctets') then true when name in ('sysUpTime', 'ifNumber', 'ifDescr') then false else chartable end,
		  alertable = case when name in ('cpuUsage', 'ifOperStatus') then true when name in ('sysUpTime', 'ifNumber', 'ifDescr', 'ifInOctets', 'ifOutOctets') then false else alertable end
		where name in ('sysUpTime', 'ifNumber', 'cpuUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets');
		insert into oid_template_definitions (template_id, metric_id, sort_order)
		select t.id, m.id,
		  case m.name
		    when 'sysUpTime' then 10
		    when 'ifNumber' then 20
		    when 'huaweiCpuUsage' then 30
		    when 'huaweiMemoryUsage' then 40
		    when 'ifDescr' then 100
		    when 'ifOperStatus' then 110
		    when 'ifInOctets' then 120
		    when 'ifOutOctets' then 130
		    else 999
		  end
		from oid_templates t
		join metric_definitions m on m.name in ('sysUpTime', 'ifNumber', 'huaweiCpuUsage', 'huaweiMemoryUsage', 'ifDescr', 'ifOperStatus', 'ifInOctets', 'ifOutOctets')
		where t.name = '华为 SNMP 模板'
		on conflict (template_id, metric_id) do nothing;
		insert into oid_template_definitions (template_id, metric_id, sort_order)
		select t.id, m.id,
		  case m.name
		    when 'huaweiCpuUsage' then 40
		    when 'huaweiMemoryUsage' then 50
		    else 999
		  end
		from oid_templates t
		join metric_definitions m on m.name in ('huaweiCpuUsage', 'huaweiMemoryUsage')
		where t.name = '默认 SNMP 模板'
		on conflict (template_id, metric_id) do nothing;
		update oid_template_definitions td
		set required = true
		from metric_definitions m
		where m.id = td.metric_id
		  and m.name in ('cpuUsage', 'huaweiCpuUsage', 'huaweiMemoryUsage', 'ifOperStatus');
	`)
	return err
}

func (store *PostgresStore) ListEnabledDevices(ctx context.Context) ([]collector.Device, error) {
	rows, err := store.pool.Query(ctx, `
		select
			d.id,
			d.name,
			host(d.host),
			d.port,
			coalesce(d.community, ''),
			coalesce(d.snmp_version, '2c'),
			coalesce(d.snmp_v3_username, ''),
			coalesce(d.snmp_v3_security_level, 'noAuthNoPriv'),
			coalesce(d.snmp_v3_auth_protocol, ''),
			coalesce(d.snmp_v3_auth_passphrase, ''),
			coalesce(d.snmp_v3_priv_protocol, ''),
			coalesce(d.snmp_v3_priv_passphrase, ''),
			coalesce(d.snmp_v3_context_name, ''),
			coalesce(g.template_id, 0)
		from devices d
		left join device_groups g on g.id = d.group_id
		where d.enabled = true
		order by d.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []collector.Device
	for rows.Next() {
		var device collector.Device
		if err := rows.Scan(
			&device.ID,
			&device.Name,
			&device.Host,
			&device.Port,
			&device.Community,
			&device.SNMPVersion,
			&device.SNMPV3Username,
			&device.SNMPV3SecurityLevel,
			&device.SNMPV3AuthProtocol,
			&device.SNMPV3AuthPassphrase,
			&device.SNMPV3PrivProtocol,
			&device.SNMPV3PrivPassphrase,
			&device.SNMPV3ContextName,
			&device.TemplateID,
		); err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, rows.Err()
}

func (store *PostgresStore) ListMetrics(ctx context.Context, templateID int64) ([]collector.MetricDefinition, error) {
	if templateID > 0 {
		return store.listTemplateMetrics(ctx, templateID)
	}

	rows, err := store.pool.Query(ctx, `
		select
			id,
			name,
			oid,
			coalesce(unit, ''),
			coalesce(display_name, name),
			coalesce(description, ''),
			metric_kind,
			coalesce(table_oid, ''),
			coalesce(value_type, 'gauge'),
			coalesce(scale, 1)::double precision,
			coalesce(precision, 2),
			coalesce(aggregate_method, 'latest'),
			coalesce(display_group, ''),
			coalesce(vendor, ''),
			coalesce(chartable, true),
			coalesce(alertable, false)
		from metric_definitions
		where enabled = true
		order by id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var metrics []collector.MetricDefinition
	for rows.Next() {
		var metric collector.MetricDefinition
		if err := scanMetricDefinition(rows, &metric); err != nil {
			return nil, err
		}
		metrics = append(metrics, metric)
	}
	return metrics, rows.Err()
}

func scanMetricDefinition(rows pgx.Rows, metric *collector.MetricDefinition) error {
	return rows.Scan(
		&metric.ID,
		&metric.Name,
		&metric.OID,
		&metric.Unit,
		&metric.DisplayName,
		&metric.Description,
		&metric.MetricKind,
		&metric.TableOID,
		&metric.ValueType,
		&metric.Scale,
		&metric.Precision,
		&metric.AggregateMethod,
		&metric.DisplayGroup,
		&metric.Vendor,
		&metric.Chartable,
		&metric.Alertable,
	)
}

func (store *PostgresStore) listTemplateMetrics(ctx context.Context, templateID int64) ([]collector.MetricDefinition, error) {
	rows, err := store.pool.Query(ctx, `
		select
			m.id,
			m.name,
			m.oid,
			coalesce(m.unit, ''),
			coalesce(m.display_name, m.name),
			coalesce(m.description, ''),
			m.metric_kind,
			coalesce(m.table_oid, ''),
			coalesce(m.value_type, 'gauge'),
			coalesce(m.scale, 1)::double precision,
			coalesce(m.precision, 2),
			coalesce(m.aggregate_method, 'latest'),
			coalesce(m.display_group, ''),
			coalesce(m.vendor, ''),
			coalesce(m.chartable, true),
			coalesce(m.alertable, false)
		from oid_template_definitions td
		join metric_definitions m on m.id = td.metric_id
		join oid_templates t on t.id = td.template_id
		where td.template_id = $1 and t.enabled = true and m.enabled = true and td.enabled = true
		order by td.sort_order, m.id
	`, templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var metrics []collector.MetricDefinition
	for rows.Next() {
		var metric collector.MetricDefinition
		if err := scanMetricDefinition(rows, &metric); err != nil {
			return nil, err
		}
		metrics = append(metrics, metric)
	}
	return metrics, rows.Err()
}

func (store *PostgresStore) SaveSamples(ctx context.Context, samples []collector.MetricSample) error {
	batch := &pgx.Batch{}
	for _, sample := range samples {
		batch.Queue(`
			insert into metric_samples (device_id, metric_id, value_text, created_at)
			values ($1, $2, $3, $4)
		`, sample.DeviceID, sample.MetricID, sample.Value, sample.CreatedAt)
	}

	results := store.pool.SendBatch(ctx, batch)
	defer results.Close()

	for range samples {
		if _, err := results.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (store *PostgresStore) UpsertInterface(ctx context.Context, info collector.InterfaceInfo) (int64, error) {
	var id int64
	err := store.pool.QueryRow(ctx, `
		insert into device_interfaces (
			device_id,
			if_index,
			if_descr,
			if_name,
			if_alias,
			oper_status,
			last_seen_at,
			updated_at
		)
		values ($1, $2, nullif($3, ''), nullif($4, ''), nullif($5, ''), nullif($6, ''), $7, now())
		on conflict (device_id, if_index)
		do update set
			if_descr = coalesce(excluded.if_descr, device_interfaces.if_descr),
			if_name = coalesce(excluded.if_name, device_interfaces.if_name),
			if_alias = coalesce(excluded.if_alias, device_interfaces.if_alias),
			oper_status = coalesce(excluded.oper_status, device_interfaces.oper_status),
			last_seen_at = excluded.last_seen_at,
			updated_at = now()
		returning id
	`, info.DeviceID, info.IfIndex, info.IfDescr, info.IfName, info.IfAlias, info.OperStatus, info.LastSeenAt).Scan(&id)
	return id, err
}

func (store *PostgresStore) SaveInterfaceSamples(ctx context.Context, samples []collector.InterfaceMetricSample) error {
	batch := &pgx.Batch{}
	for _, sample := range samples {
		batch.Queue(`
			insert into interface_metric_samples (device_id, interface_id, metric_id, value_text, created_at)
			values ($1, $2, $3, $4, $5)
		`, sample.DeviceID, sample.InterfaceID, sample.MetricID, sample.Value, sample.CreatedAt)
	}

	results := store.pool.SendBatch(ctx, batch)
	defer results.Close()

	for range samples {
		if _, err := results.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (store *PostgresStore) SaveNeighbors(ctx context.Context, deviceID int64, neighbors []collector.NeighborInfo) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		update device_neighbors
		set stale = true,
			updated_at = now()
		where device_id = $1
	`, deviceID); err != nil {
		return err
	}

	for _, neighbor := range neighbors {
		raw, err := json.Marshal(neighbor.Raw)
		if err != nil {
			return err
		}
		if neighbor.LastSeenAt.IsZero() {
			neighbor.LastSeenAt = time.Now().UTC()
		}
		_, err = tx.Exec(ctx, `
			with local_interface as (
				select id
				from device_interfaces
				where device_id = $1
					and (
						($2::integer is not null and if_index = $2)
						or ($3 <> '' and (
							lower(coalesce(if_name, '')) = lower($3)
							or lower(coalesce(if_descr, '')) = lower($3)
							or lower(coalesce(if_alias, '')) = lower($3)
						))
						or ($4 <> '' and (
							lower(coalesce(if_name, '')) = lower($4)
							or lower(coalesce(if_descr, '')) = lower($4)
							or lower(coalesce(if_alias, '')) = lower($4)
						))
					)
				order by case when $2::integer is not null and if_index = $2 then 0 else 1 end
				limit 1
			),
			remote_device as (
				select id
				from devices
				where ($11::inet is not null and host = $11::inet)
					or ($8 <> '' and (
						lower(name) = lower($8)
						or lower(split_part(name, '.', 1)) = lower(split_part($8, '.', 1))
					))
					or ($12 <> '' and (
						lower(name) = lower($12)
						or lower(split_part(name, '.', 1)) = lower(split_part($12, '.', 1))
					))
				order by case when $11::inet is not null and host = $11::inet then 0 else 1 end
				limit 1
			),
			remote_interface as (
				select i.id
				from device_interfaces i
				join remote_device d on d.id = i.device_id
				where ($9 <> '' and (
						lower(coalesce(i.if_name, '')) = lower($9)
						or lower(coalesce(i.if_descr, '')) = lower($9)
						or lower(coalesce(i.if_alias, '')) = lower($9)
					))
					or ($10 <> '' and (
						lower(coalesce(i.if_name, '')) = lower($10)
						or lower(coalesce(i.if_descr, '')) = lower($10)
						or lower(coalesce(i.if_alias, '')) = lower($10)
					))
				limit 1
			)
			insert into device_neighbors (
				device_id,
				local_interface_id,
				local_if_index,
				local_port_id,
				local_port_descr,
				protocol,
				fingerprint,
				remote_chassis_id,
				remote_device_name,
				remote_port_id,
				remote_port_descr,
				remote_mgmt_address,
				remote_sys_name,
				remote_sys_descr,
				remote_device_id,
				remote_interface_id,
				last_seen_at,
				updated_at,
				stale,
				raw
			)
			values (
				$1,
				(select id from local_interface),
				$2,
				nullif($3, ''),
				nullif($4, ''),
				$5,
				$6,
				nullif($7, ''),
				nullif($8, ''),
				nullif($9, ''),
				nullif($10, ''),
				$11,
				nullif($12, ''),
				nullif($13, ''),
				(select id from remote_device),
				(select id from remote_interface),
				$14,
				now(),
				false,
				$15::jsonb
			)
			on conflict (fingerprint)
			do update set
				local_interface_id = excluded.local_interface_id,
				local_if_index = excluded.local_if_index,
				local_port_id = excluded.local_port_id,
				local_port_descr = excluded.local_port_descr,
				remote_chassis_id = excluded.remote_chassis_id,
				remote_device_name = excluded.remote_device_name,
				remote_port_id = excluded.remote_port_id,
				remote_port_descr = excluded.remote_port_descr,
				remote_mgmt_address = excluded.remote_mgmt_address,
				remote_sys_name = excluded.remote_sys_name,
				remote_sys_descr = excluded.remote_sys_descr,
				remote_device_id = excluded.remote_device_id,
				remote_interface_id = excluded.remote_interface_id,
				last_seen_at = excluded.last_seen_at,
				updated_at = now(),
				stale = false,
				raw = excluded.raw
		`,
			deviceID,
			nullInt(neighbor.LocalIfIndex),
			neighbor.LocalPortID,
			neighbor.LocalPortDescr,
			neighbor.Protocol,
			neighborFingerprint(neighbor),
			neighbor.RemoteChassisID,
			neighbor.RemoteDeviceName,
			neighbor.RemotePortID,
			neighbor.RemotePortDescr,
			nullString(neighbor.RemoteMgmtAddress),
			neighbor.RemoteSysName,
			neighbor.RemoteSysDescr,
			neighbor.LastSeenAt,
			string(raw),
		)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (store *PostgresStore) ListAlertRules(ctx context.Context) ([]collector.AlertRule, error) {
	rows, err := store.pool.Query(ctx, `
		select
			id,
			name,
			rule_type,
			severity,
			coalesce(device_id, 0),
			coalesce(interface_id, 0),
			coalesce(metric_name, ''),
			coalesce(operator, ''),
			coalesce(threshold, 0),
			enabled
		from alert_rules
		where enabled = true
		order by id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []collector.AlertRule
	for rows.Next() {
		var rule collector.AlertRule
		if err := rows.Scan(
			&rule.ID,
			&rule.Name,
			&rule.RuleType,
			&rule.Severity,
			&rule.DeviceID,
			&rule.InterfaceID,
			&rule.MetricName,
			&rule.Operator,
			&rule.Threshold,
			&rule.Enabled,
		); err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func (store *PostgresStore) UpsertAlertEvent(ctx context.Context, event collector.AlertEvent) (int64, bool, error) {
	var id int64
	var created bool
	err := store.pool.QueryRow(ctx, `
		insert into alert_events (
			rule_id,
			device_id,
			interface_id,
			severity,
			status,
			title,
			message,
			value_text,
			triggered_at,
			last_seen_at
		)
		values ($1, $2, nullif($3, 0), $4, 'active', $5, $6, $7, $8, $8)
		on conflict (
			coalesce(rule_id, 0),
			coalesce(device_id, 0),
			coalesce(interface_id, 0),
			title
		)
		where status = 'active'
		do update set
			severity = excluded.severity,
			message = excluded.message,
			value_text = excluded.value_text,
			last_seen_at = excluded.last_seen_at
		returning id, (xmax = 0) as created
	`, event.RuleID, event.DeviceID, event.InterfaceID, event.Severity, event.Title, event.Message, event.Value, event.CreatedAt).Scan(&id, &created)
	return id, created, err
}

func (store *PostgresStore) ResolveAlertEvent(ctx context.Context, ruleID int64, deviceID int64, interfaceID int64, title string) (*collector.AlertEvent, error) {
	var event collector.AlertEvent
	err := store.pool.QueryRow(ctx, `
		update alert_events e
		set status = 'resolved',
			resolved_at = now(),
			last_seen_at = now()
		from devices d
		where e.device_id = d.id
			and e.status = 'active'
			and coalesce(e.rule_id, 0) = $1
			and coalesce(e.device_id, 0) = $2
			and coalesce(e.interface_id, 0) = $3
			and e.title = $4
		returning
			e.id,
			coalesce(e.rule_id, 0),
			coalesce(e.device_id, 0),
			coalesce(e.interface_id, 0),
			e.severity,
			e.title,
			coalesce(e.message, ''),
			coalesce(e.value_text, ''),
			e.triggered_at,
			coalesce(e.resolved_at, now()),
			e.status,
			d.name
	`, ruleID, deviceID, interfaceID, title).Scan(
		&event.ID,
		&event.RuleID,
		&event.DeviceID,
		&event.InterfaceID,
		&event.Severity,
		&event.Title,
		&event.Message,
		&event.Value,
		&event.CreatedAt,
		&event.ResolvedAt,
		&event.Status,
		&event.DeviceName,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &event, err
}

func (store *PostgresStore) CreateAlertNotification(ctx context.Context, notification collector.AlertNotification) error {
	_, err := store.pool.Exec(ctx, `
		insert into alert_notifications (
			event_id,
			channel,
			target,
			status,
			subject,
			message,
			next_retry_at,
			updated_at
		)
		values ($1, $2, $3, 'pending', $4, $5, now(), now())
		on conflict (event_id, channel, target, subject) do nothing
	`, notification.EventID, notification.Channel, notification.Target, notification.Subject, notification.Message)
	return err
}

func (store *PostgresStore) ResetStaleSendingNotifications(ctx context.Context, staleAfter time.Duration) error {
	_, err := store.pool.Exec(ctx, `
		update alert_notifications
		set status = 'pending',
			next_retry_at = now(),
			updated_at = now()
		where status = 'sending'
			and updated_at < now() - make_interval(secs => $1)
	`, int(staleAfter.Seconds()))
	return err
}

func (store *PostgresStore) ClaimPendingNotifications(ctx context.Context, limit int) ([]collector.AlertNotification, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := store.pool.Query(ctx, `
		with picked as (
			select id
			from alert_notifications
			where channel = 'email'
				and status = 'pending'
				and next_retry_at <= now()
			order by created_at
			limit $1
			for update skip locked
		)
		update alert_notifications n
		set status = 'sending',
			updated_at = now()
		from picked
		where n.id = picked.id
		returning
			n.id,
			n.event_id,
			n.channel,
			coalesce(n.target, ''),
			n.status,
			coalesce(n.subject, ''),
			coalesce(n.message, ''),
			coalesce(n.error, ''),
			n.retry_count,
			n.created_at,
			coalesce(n.sent_at, 'epoch'::timestamptz)
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notifications []collector.AlertNotification
	for rows.Next() {
		var notification collector.AlertNotification
		if err := rows.Scan(
			&notification.ID,
			&notification.EventID,
			&notification.Channel,
			&notification.Target,
			&notification.Status,
			&notification.Subject,
			&notification.Message,
			&notification.Error,
			&notification.RetryCount,
			&notification.CreatedAt,
			&notification.SentAt,
		); err != nil {
			return nil, err
		}
		notifications = append(notifications, notification)
	}
	return notifications, rows.Err()
}

func (store *PostgresStore) MarkNotificationSent(ctx context.Context, id int64) error {
	_, err := store.pool.Exec(ctx, `
		update alert_notifications
		set status = 'sent',
			error = null,
			sent_at = now(),
			updated_at = now()
		where id = $1
	`, id)
	return err
}

func (store *PostgresStore) MarkNotificationFailed(ctx context.Context, id int64, reason string, retryDelay time.Duration, maxRetries int) error {
	status := "pending"
	if maxRetries <= 0 {
		maxRetries = 3
	}
	_, err := store.pool.Exec(ctx, `
		update alert_notifications
		set status = case when retry_count + 1 >= $4 then 'failed' else $2 end,
			error = $3,
			retry_count = retry_count + 1,
			next_retry_at = case when retry_count + 1 >= $4 then next_retry_at else now() + make_interval(secs => $5) end,
			updated_at = now()
		where id = $1
	`, id, status, reason, maxRetries, int(retryDelay.Seconds()))
	return err
}

func (store *PostgresStore) CleanupOldData(ctx context.Context, policy collector.RetentionPolicy) (collector.CleanupStats, error) {
	var stats collector.CleanupStats
	batchSize := policy.BatchSize
	if batchSize <= 0 {
		batchSize = 5000
	}

	if policy.InterfaceSamplesDays > 0 {
		deleted, err := store.deleteOldRows(ctx, `
			delete from interface_metric_samples
			where id in (
				select id
				from interface_metric_samples
				where created_at < now() - make_interval(days => $1)
				order by created_at
				limit $2
			)
		`, policy.InterfaceSamplesDays, batchSize)
		if err != nil {
			return stats, err
		}
		stats.InterfaceSamples = deleted
	}

	if policy.MetricSamplesDays > 0 {
		deleted, err := store.deleteOldRows(ctx, `
			delete from metric_samples
			where id in (
				select id
				from metric_samples
				where created_at < now() - make_interval(days => $1)
				order by created_at
				limit $2
			)
		`, policy.MetricSamplesDays, batchSize)
		if err != nil {
			return stats, err
		}
		stats.MetricSamples = deleted
	}

	if policy.ResolvedAlertsDays > 0 {
		deleted, err := store.deleteOldRows(ctx, `
			delete from alert_events
			where id in (
				select id
				from alert_events
				where status = 'resolved'
					and coalesce(resolved_at, last_seen_at, triggered_at) < now() - make_interval(days => $1)
				order by coalesce(resolved_at, last_seen_at, triggered_at)
				limit $2
			)
		`, policy.ResolvedAlertsDays, batchSize)
		if err != nil {
			return stats, err
		}
		stats.ResolvedAlerts = deleted
	}

	if policy.AlertNotificationsDays > 0 {
		deleted, err := store.deleteOldRows(ctx, `
			delete from alert_notifications
			where id in (
				select id
				from alert_notifications
				where created_at < now() - make_interval(days => $1)
				order by created_at
				limit $2
			)
		`, policy.AlertNotificationsDays, batchSize)
		if err != nil {
			return stats, err
		}
		stats.AlertNotifications = deleted
	}

	if policy.DiscoveryHistoryDays > 0 {
		deleted, err := store.deleteOldRows(ctx, `
			delete from discovery_jobs
			where id in (
				select id
				from discovery_jobs
				where created_at < now() - make_interval(days => $1)
					and status in ('completed', 'failed', 'canceled')
				order by created_at
				limit $2
			)
		`, policy.DiscoveryHistoryDays, batchSize)
		if err != nil {
			return stats, err
		}
		stats.DiscoveryJobs = deleted
	}

	return stats, nil
}

func (store *PostgresStore) deleteOldRows(ctx context.Context, query string, retentionDays int, batchSize int) (int64, error) {
	var total int64
	for {
		result, err := store.pool.Exec(ctx, query, retentionDays, batchSize)
		if err != nil {
			return total, err
		}
		affected := result.RowsAffected()
		total += affected
		if affected < int64(batchSize) {
			return total, nil
		}
	}
}

func neighborFingerprint(neighbor collector.NeighborInfo) string {
	return fmt.Sprintf(
		"%d|%s|%d|%s|%s|%s",
		neighbor.DeviceID,
		strings.ToLower(strings.TrimSpace(neighbor.Protocol)),
		neighbor.LocalIfIndex,
		strings.ToLower(strings.TrimSpace(firstNonEmpty(neighbor.LocalPortID, neighbor.LocalPortDescr))),
		strings.ToLower(strings.TrimSpace(firstNonEmpty(neighbor.RemoteChassisID, neighbor.RemoteDeviceName, neighbor.RemoteSysName))),
		strings.ToLower(strings.TrimSpace(firstNonEmpty(neighbor.RemotePortID, neighbor.RemotePortDescr))),
	)
}

func nullInt(value int) interface{} {
	if value == 0 {
		return nil
	}
	return value
}

func nullString(value string) interface{} {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}
