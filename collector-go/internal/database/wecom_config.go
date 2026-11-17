package database

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"snmp-monitor/collector-go/internal/wecomconfig"
)

func (store *PostgresStore) LoadWeComConfig(ctx context.Context) (*wecomconfig.Config, error) {
	var raw []byte
	err := store.pool.QueryRow(ctx, "select config from wecom_app_notification_config where id = 1").Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var config wecomconfig.Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, err
	}
	return &config, nil
}
