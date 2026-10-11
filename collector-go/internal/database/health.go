package database

import (
	"context"
	"snmp-monitor/collector-go/internal/collector"
	"time"
)

const activitySQL = `greatest(d.created_at,
 (select max(created_at) from metric_samples where device_id=d.id),
 (select max(created_at) from interface_metric_samples where device_id=d.id),
 (select max(last_seen_at) from device_interfaces where device_id=d.id))`

func (store *PostgresStore) ListHealthCandidates(ctx context.Context, stale time.Duration) ([]collector.HealthCandidate, error) {
	devices, err := store.ListEnabledDevices(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := store.pool.Query(ctx, `select d.id, `+activitySQL+`, d.updated_at from devices d where d.enabled and `+activitySQL+` < now()-make_interval(secs=>$1)`, int(stale.Seconds()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[int64]collector.Device, len(devices))
	for _, device := range devices {
		byID[device.ID] = device
	}
	var candidates []collector.HealthCandidate
	for rows.Next() {
		var id int64
		var last time.Time
		var configUpdated time.Time
		if err := rows.Scan(&id, &last, &configUpdated); err != nil {
			return nil, err
		}
		if device, ok := byID[id]; ok && device.UpdatedAt.Equal(configUpdated) {
			candidates = append(candidates, collector.HealthCandidate{Device: device, LastActivity: last, ConfigUpdatedAt: configUpdated})
		}
	}
	return candidates, rows.Err()
}

func (store *PostgresStore) SaveHealthObservation(ctx context.Context, id int64, o collector.HealthObservation, last, configUpdated time.Time) error {
	status := "checking"
	failures := 1
	if o.SNMPOK || o.PingOK {
		status = "collection_error"
		failures = 0
	} else if !o.Conclusive {
		status = "unknown"
		failures = 0
	}
	_, err := store.pool.Exec(ctx, `
 insert into device_health(device_id,checked_at,status,consecutive_failures,first_failed_at,reason,snmp_ok,ping_ok)
 select d.id,now(),$2,$3,case when $3=1 then now() end,$4,$5,$6
 from devices d where d.id=$1 and d.enabled and d.updated_at=$8 and `+activitySQL+` <= $7
 on conflict(device_id) do update set
 checked_at=now(), reason=excluded.reason,snmp_ok=excluded.snmp_ok,ping_ok=excluded.ping_ok,
 consecutive_failures=case when $3=0 then 0 when device_health.checked_at < greatest($7,$8) or device_health.checked_at < now()-interval '90 seconds' then 1 else device_health.consecutive_failures+1 end,
 first_failed_at=case when $3=0 then null when device_health.consecutive_failures=0 or device_health.checked_at < greatest($7,$8) or device_health.checked_at < now()-interval '90 seconds' then now() else device_health.first_failed_at end,
 status=case when $3=0 then $2 when device_health.checked_at >= greatest($7,$8)
 and device_health.checked_at >= now()-interval '90 seconds'
 and device_health.consecutive_failures+1>=3 and device_health.first_failed_at<=now()-interval '60 seconds'
 then 'offline' else 'checking' end`, id, status, failures, o.Reason, o.SNMPOK, o.PingOK, last, configUpdated)
	return err
}
