package database

import (
	"context"
	"os"
	"testing"
)

func TestTopologyRequestLifecycle(t *testing.T) {
	dsn := os.Getenv("TOPOLOGY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated topology database")
	}
	ctx := context.Background()
	store, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var device, id int64
	if err := store.pool.QueryRow(ctx, `insert into devices(name,host) values('request fixture','192.0.2.249') returning id`).Scan(&device); err != nil {
		t.Fatal(err)
	}
	defer store.pool.Exec(ctx, `delete from devices where id=$1`, device)
	insert := func() int64 {
		t.Helper()
		var n int64
		if err := store.pool.QueryRow(ctx, `insert into topology_scan_requests(device_id) values($1) returning id`, device).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	id = insert()
	pending, err := store.ListTopologyRequests(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range pending {
		if r.ID == id {
			found = true
		}
	}
	if !found {
		t.Fatal("request not visible to scheduler")
	}
	if ok, err := store.ClaimTopologyRequest(ctx, id); err != nil || !ok {
		t.Fatalf("claim=%t %v", ok, err)
	}
	if ok, err := store.ClaimTopologyRequest(ctx, id); err != nil || ok {
		t.Fatal("duplicate claim")
	}
	if err := store.FinishTopologyRequest(ctx, id, "completed", "finished"); err != nil {
		t.Fatal(err)
	}
	id = insert()
	if _, err := store.ClaimTopologyRequest(ctx, id); err != nil {
		t.Fatal(err)
	}
	store.pool.Exec(ctx, `update topology_scan_requests set started_at=now()-interval '3 minutes' where id=$1`, id)
	if _, err := store.ListTopologyRequests(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := store.pool.QueryRow(ctx, `select status from topology_scan_requests where id=$1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatal("stale task did not recover")
	}
	id = insert()
	store.pool.Exec(ctx, `update devices set enabled=false where id=$1`, device)
	if _, err := store.ListTopologyRequests(ctx); err != nil {
		t.Fatal(err)
	}
	if ok, _ := store.ClaimTopologyRequest(ctx, id); ok {
		t.Fatal("disabled device claimed")
	}
}
