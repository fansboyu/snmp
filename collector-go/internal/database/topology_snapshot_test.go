package database

import (
	"context"
	"os"
	"snmp-monitor/collector-go/internal/collector"
	"testing"
	"time"
)

func TestTopologyProtocolSnapshotPreservesEvidence(t *testing.T) {
	dsn := os.Getenv("TOPOLOGY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated topology test database")
	}
	ctx := context.Background()
	store, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var id int64
	if err := store.pool.QueryRow(ctx, `insert into devices(name,host,enabled) values('snapshot fixture','192.0.2.240',false) returning id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	defer store.pool.Exec(ctx, `delete from devices where id=$1`, id)
	rows := []collector.NeighborInfo{{DeviceID: id, Protocol: "lldp", LocalPortID: "p1", RemoteChassisID: "a", RemotePortID: "p2", LastSeenAt: time.Now().UTC()},
		{DeviceID: id, Protocol: "cdp", LocalPortID: "p1", RemoteChassisID: "a", RemotePortID: "p2", LastSeenAt: time.Now().UTC()}}
	if err := store.SaveNeighbors(ctx, id, rows); err != nil {
		t.Fatal(err)
	}
	save := func(status, protocol string) {
		t.Helper()
		if err := store.SaveTopologySnapshot(ctx, id, collector.TopologySnapshot{Scans: []collector.TopologyScan{{Protocol: protocol, Status: status, CheckedAt: time.Now().UTC()}}}); err != nil {
			t.Fatal(err)
		}
	}
	count := func(protocol string) int {
		t.Helper()
		var n int
		if err := store.pool.QueryRow(ctx, `select count(*) from device_neighbors where device_id=$1 and protocol=$2 and not stale`, id, protocol).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	save("failed", "lldp")
	if count("lldp") != 1 {
		t.Fatal("failure expired healthy evidence")
	}
	save("partial", "lldp")
	if count("lldp") != 1 {
		t.Fatal("partial result expired healthy evidence")
	}
	save("empty", "lldp")
	if count("lldp") != 0 || count("cdp") != 1 {
		t.Fatal("complete empty must expire only its own protocol")
	}
	save("unsupported", "cdp")
	if count("cdp") != 1 {
		t.Fatal("invisible protocol must not immediately remove evidence")
	}
}
