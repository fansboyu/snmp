package database

import (
	"context"
	"time"
)

func (store *PostgresStore) ConfirmAlertCondition(ctx context.Context, ruleID, deviceID, interfaceID int64, condition bool, duration, maxGap time.Duration) (bool, error) {
	if !condition {
		_, err := store.pool.Exec(ctx, `delete from alert_rule_observations where rule_id=$1 and device_id=$2 and interface_id=$3`, ruleID, deviceID, interfaceID)
		return false, err
	}
	var first time.Time
	err := store.pool.QueryRow(ctx, `
		insert into alert_rule_observations(rule_id,device_id,interface_id)
		values($1,$2,$3)
		on conflict(rule_id,device_id,interface_id) do update set
			first_observed_at=case when alert_rule_observations.last_observed_at < now()-make_interval(secs=>$4) then now() else alert_rule_observations.first_observed_at end,
			last_observed_at=now()
		returning first_observed_at
	`, ruleID, deviceID, interfaceID, int(maxGap.Seconds())).Scan(&first)
	if err != nil {
		return false, err
	}
	return duration <= 0 || !time.Now().Before(first.Add(duration)), nil
}
