package collector

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type scheduleStore struct {
	Store
	mu                 sync.Mutex
	devices            []Device
	maintenanceEntered chan struct{}
}

func (store *scheduleStore) ListEnabledDevices(ctx context.Context) ([]Device, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]Device(nil), store.devices...), nil
}

func (store *scheduleStore) CleanupOldData(ctx context.Context, policy RetentionPolicy) (CleanupStats, error) {
	select {
	case store.maintenanceEntered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return CleanupStats{}, ctx.Err()
}

func testEngine(store Store) *Engine {
	return &Engine{Store: store, Interval: 30 * time.Millisecond, RefreshInterval: 5 * time.Millisecond,
		DeviceTimeout: 180 * time.Millisecond, NeighborInterval: time.Hour, NeighborTimeout: 20 * time.Millisecond,
		DatabaseTimeout: time.Second, MaintenanceTimeout: time.Second, WorkerCount: 2}
}

func TestIndependentSchedulingAndNoOverlap(t *testing.T) {
	store := &scheduleStore{devices: []Device{{ID: 1}, {ID: 2}}}
	engine := testEngine(store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var fastCount, slowCount, neighborCount, overlaps atomic.Int32
	var mu sync.Mutex
	active := map[int64]bool{}
	fastReady := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		engine.runScheduler(ctx, func(job collectionJob) bool {
			mu.Lock()
			if active[job.device.ID] {
				overlaps.Add(1)
			}
			active[job.device.ID] = true
			mu.Unlock()
			defer func() { mu.Lock(); active[job.device.ID] = false; mu.Unlock() }()
			if job.neighbors {
				neighborCount.Add(1)
				return true
			}
			if job.device.ID == 1 {
				slowCount.Add(1)
				<-job.ctx.Done()
				return false
			}
			if fastCount.Add(1) == 3 {
				fastReady <- struct{}{}
			}
			return true
		})
		close(done)
	}()
	select {
	case <-fastReady:
	case <-time.After(2 * time.Second):
		t.Fatal("healthy device blocked behind slow device")
	}
	if slowCount.Load() != 1 {
		t.Errorf("slow device ran %d times before its first deadline", slowCount.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler failed to stop")
	}
	if overlaps.Load() != 0 {
		t.Fatal("same device tasks overlapped")
	}
	if neighborCount.Load() != 1 {
		t.Fatalf("neighbors should run once, got %d", neighborCount.Load())
	}
}

func TestMaintenanceDoesNotBlockCollection(t *testing.T) {
	store := &scheduleStore{devices: []Device{{ID: 1}}, maintenanceEntered: make(chan struct{}, 1)}
	engine := testEngine(store)
	engine.RetentionPolicy = RetentionPolicy{MetricSamplesDays: 30}
	engine.CleanupInterval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	collected := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		engine.runScheduler(ctx, func(job collectionJob) bool {
			select {
			case collected <- struct{}{}:
			default:
			}
			return true
		})
		close(done)
	}()
	select {
	case <-store.maintenanceEntered:
	case <-time.After(time.Second):
		t.Fatal("maintenance never started")
	}
	select {
	case <-collected:
	case <-time.After(time.Second):
		t.Fatal("maintenance blocked collection")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance failed to cancel")
	}
}

func TestDisabledDeviceCancelsInFlightJob(t *testing.T) {
	store := &scheduleStore{devices: []Device{{ID: 1}}}
	engine := testEngine(store)
	engine.DeviceTimeout = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, stopped, done := make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{})
	go func() {
		engine.runScheduler(ctx, func(job collectionJob) bool {
			started <- struct{}{}
			<-job.ctx.Done()
			stopped <- struct{}{}
			return false
		})
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("job never started")
	}
	store.mu.Lock()
	store.devices = nil
	store.mu.Unlock()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("disabled device was not canceled")
	}
	cancel()
	<-done
}

func TestScheduleSkipsMissedSlotsAndCapsBackoff(t *testing.T) {
	due := time.Unix(0, 0)
	if got := nextSlot(due, due.Add(250*time.Millisecond), 100*time.Millisecond); !got.Equal(due.Add(300 * time.Millisecond)) {
		t.Fatalf("next slot=%s", got)
	}
	if failureDelay(time.Minute, 50) != 8*time.Minute {
		t.Fatal("backoff not capped")
	}
}

func TestSNMPHonorsDeviceContextDeadline(t *testing.T) {
	// Bound UDP socket deliberately drops all requests: the 3-second request
	// timeout must be cut short by the device context, including retries.
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	engine := &Engine{Timeout: 3 * time.Second, Retries: 1, DefaultCommunity: "public"}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	engine.collectDevice(ctx, Device{Host: "127.0.0.1", Port: socket.LocalAddr().(*net.UDPAddr).Port, SNMPVersion: "2c"}, nil)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("SNMP ignored task deadline: %s", elapsed)
	}
}
