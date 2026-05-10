package database

import (
	"context"

	"snmp-monitor/collector-go/internal/collector"

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
	return &PostgresStore{pool: pool}, nil
}

func (store *PostgresStore) Close() {
	store.pool.Close()
}

func (store *PostgresStore) ListEnabledDevices(ctx context.Context) ([]collector.Device, error) {
	rows, err := store.pool.Query(ctx, `
		select
			d.id,
			d.name,
			d.host,
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
		select id, name, oid, coalesce(unit, ''), metric_kind, coalesce(table_oid, '')
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
		if err := rows.Scan(&metric.ID, &metric.Name, &metric.OID, &metric.Unit, &metric.MetricKind, &metric.TableOID); err != nil {
			return nil, err
		}
		metrics = append(metrics, metric)
	}
	return metrics, rows.Err()
}

func (store *PostgresStore) listTemplateMetrics(ctx context.Context, templateID int64) ([]collector.MetricDefinition, error) {
	rows, err := store.pool.Query(ctx, `
		select m.id, m.name, m.oid, coalesce(m.unit, ''), m.metric_kind, coalesce(m.table_oid, '')
		from oid_template_definitions td
		join metric_definitions m on m.id = td.metric_id
		join oid_templates t on t.id = td.template_id
		where td.template_id = $1 and t.enabled = true and m.enabled = true
		order by td.sort_order, m.id
	`, templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var metrics []collector.MetricDefinition
	for rows.Next() {
		var metric collector.MetricDefinition
		if err := rows.Scan(&metric.ID, &metric.Name, &metric.OID, &metric.Unit, &metric.MetricKind, &metric.TableOID); err != nil {
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

func (store *PostgresStore) UpsertAlertEvent(ctx context.Context, event collector.AlertEvent) error {
	_, err := store.pool.Exec(ctx, `
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
	`, event.RuleID, event.DeviceID, event.InterfaceID, event.Severity, event.Title, event.Message, event.Value, event.CreatedAt)
	return err
}

func (store *PostgresStore) ResolveAlertEvent(ctx context.Context, ruleID int64, deviceID int64, interfaceID int64, title string) error {
	_, err := store.pool.Exec(ctx, `
		update alert_events
		set status = 'resolved',
			resolved_at = now(),
			last_seen_at = now()
		where status = 'active'
			and coalesce(rule_id, 0) = $1
			and coalesce(device_id, 0) = $2
			and coalesce(interface_id, 0) = $3
			and title = $4
	`, ruleID, deviceID, interfaceID, title)
	return err
}
