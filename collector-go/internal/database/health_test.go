package database

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"snmp-monitor/collector-go/internal/collector"
	"testing"
	"time"
)

func TestHealthConfirmationAndRecovery(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL health integration tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := &PostgresStore{pool: pool}
	var id int64
	var activity, updated time.Time
	err = pool.QueryRow(ctx, `insert into devices(name,host,community,created_at) values('health integration fixture','192.0.2.253','test',now()-interval '7 minutes') returning id,created_at,updated_at`).Scan(&id, &activity, &updated)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, `delete from devices where id=$1`, id)
	check := func(want string, count int) {
		t.Helper()
		var status string
		var failures int
		if err := pool.QueryRow(ctx, `select status,consecutive_failures from device_health where device_id=$1`, id).Scan(&status, &failures); err != nil {
			t.Fatal(err)
		}
		if status != want || failures != count {
			t.Fatalf("got %s/%d, want %s/%d", status, failures, want, count)
		}
	}
	save := func(o collector.HealthObservation) {
		t.Helper()
		if err := store.SaveHealthObservation(ctx, id, o, activity, updated); err != nil {
			t.Fatal(err)
		}
	}
	failed := collector.HealthObservation{Conclusive: true, Reason: "fixture loss"}
	save(failed)
	check("checking", 1)
	save(failed)
	check("checking", 2)
	save(failed)
	check("checking", 3) // Three quick failures alone are insufficient.
	if _, err := pool.Exec(ctx, `update device_health set first_failed_at=now()-interval '61 seconds' where device_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	save(failed)
	check("offline", 4)
	save(collector.HealthObservation{PingOK: true, Conclusive: true})
	check("collection_error", 0)
	save(failed)
	check("checking", 1)
	save(collector.HealthObservation{Reason: "ping permission failure"})
	check("unknown", 0)
	save(failed)
	check("checking", 1)
	if _, err := pool.Exec(ctx, `update device_health set checked_at=now()-interval '2 minutes' where device_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	save(failed)
	check("checking", 1) // Old evidence cannot confirm a new outage.
	save(collector.HealthObservation{SNMPOK: true, Conclusive: true})
	check("collection_error", 0)
	// A concurrent successful collection makes the in-flight failed probe obsolete.
	if _, err := pool.Exec(ctx, `insert into device_interfaces(device_id,if_index,last_seen_at) values($1,999,now())`, id); err != nil {
		t.Fatal(err)
	}
	save(failed)
	check("collection_error", 0)
	// Configuration changes and disabling a device invalidate in-flight probes.
	if _, err := pool.Exec(ctx, `delete from device_interfaces where device_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update devices set updated_at=now() where id=$1`, id); err != nil {
		t.Fatal(err)
	}
	save(failed)
	check("collection_error", 0)
	if err := pool.QueryRow(ctx, `select updated_at from devices where id=$1`, id).Scan(&updated); err != nil {
		t.Fatal(err)
	}
	candidates, err := store.ListHealthCandidates(ctx, 6*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range candidates {
		if candidate.Device.ID == id {
			found = true
		}
	}
	if !found {
		t.Fatal("stale device missing from health candidates")
	}
	save(failed)
	check("checking", 1)
	if _, err := pool.Exec(ctx, `update devices set enabled=false where id=$1`, id); err != nil {
		t.Fatal(err)
	}
	save(failed)
	check("checking", 1)
}
