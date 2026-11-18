package database

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAlertConditionRequiresSustainedObservations(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL alert condition integration tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := &PostgresStore{pool: pool}

	var deviceID, ruleID int64
	err = pool.QueryRow(ctx, `
		insert into devices(name,host,community)
		values('alert condition integration fixture','192.0.2.252','test')
		returning id
	`).Scan(&deviceID)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `delete from devices where id=$1`, deviceID)
	err = pool.QueryRow(ctx, `
		insert into alert_rules(name,rule_type,severity,duration_seconds)
		values('alert condition integration fixture','cpu_threshold','warning',60)
		returning id
	`).Scan(&ruleID)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `delete from alert_rules where id=$1`, ruleID)

	confirmed, err := store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, true, time.Minute, 3*time.Minute)
	if err != nil || confirmed {
		t.Fatalf("first observation must remain pending: confirmed=%t err=%v", confirmed, err)
	}
	confirmed, err = store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, true, time.Minute, 3*time.Minute)
	if err != nil || confirmed {
		t.Fatalf("repeated observation before duration must remain pending: confirmed=%t err=%v", confirmed, err)
	}
	if _, err := pool.Exec(ctx, `update alert_rule_observations set first_observed_at=now()-interval '61 seconds' where rule_id=$1 and device_id=$2`, ruleID, deviceID); err != nil {
		t.Fatal(err)
	}
	confirmed, err = store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, true, time.Minute, 3*time.Minute)
	if err != nil || !confirmed {
		t.Fatalf("condition should confirm after duration: confirmed=%t err=%v", confirmed, err)
	}
	confirmed, err = store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, false, time.Minute, 3*time.Minute)
	if err != nil || confirmed {
		t.Fatalf("cleared condition must reset observation: confirmed=%t err=%v", confirmed, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from alert_rule_observations where rule_id=$1 and device_id=$2`, ruleID, deviceID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected observation reset, got %d rows", count)
	}
	if _, err := store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, true, time.Minute, 3*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update alert_rule_observations set last_observed_at=now()-interval '4 minutes', first_observed_at=now()-interval '5 minutes' where rule_id=$1 and device_id=$2`, ruleID, deviceID); err != nil {
		t.Fatal(err)
	}
	confirmed, err = store.ConfirmAlertCondition(ctx, ruleID, deviceID, 0, true, time.Minute, 3*time.Minute)
	if err != nil || confirmed {
		t.Fatalf("a long sampling gap must restart the duration: confirmed=%t err=%v", confirmed, err)
	}
	var first time.Time
	if err := pool.QueryRow(ctx, `select first_observed_at from alert_rule_observations where rule_id=$1 and device_id=$2`, ruleID, deviceID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if time.Since(first) > 10*time.Second {
		t.Fatalf("expected duration window to restart, first observation is %s old", time.Since(first))
	}
}
