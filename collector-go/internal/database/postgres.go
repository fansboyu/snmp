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
		select id, name, host, port, coalesce(community, '')
		from devices
		where enabled = true
		order by id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []collector.Device
	for rows.Next() {
		var device collector.Device
		if err := rows.Scan(&device.ID, &device.Name, &device.Host, &device.Port, &device.Community); err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, rows.Err()
}

func (store *PostgresStore) ListMetrics(ctx context.Context) ([]collector.MetricDefinition, error) {
	rows, err := store.pool.Query(ctx, `
		select id, name, oid, coalesce(unit, '')
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
		if err := rows.Scan(&metric.ID, &metric.Name, &metric.OID, &metric.Unit); err != nil {
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
