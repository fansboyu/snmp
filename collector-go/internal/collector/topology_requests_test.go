package collector

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type requestScheduleStore struct {
	*scheduleStore
	request atomic.Bool
}

func (s *requestScheduleStore) ListTopologyRequests(context.Context) ([]TopologyRequest, error) {
	if s.request.Load() {
		return []TopologyRequest{{ID: 99, DeviceID: 1}}, nil
	}
	return nil, nil
}
func (*requestScheduleStore) ClaimTopologyRequest(context.Context, int64) (bool, error) {
	return true, nil
}
func (*requestScheduleStore) FinishTopologyRequest(context.Context, int64, string, string) error {
	return nil
}

func TestManualTopologyRequestUsesSerializedScheduler(t *testing.T) {
	store := &requestScheduleStore{scheduleStore: &scheduleStore{devices: []Device{{ID: 1}}}}
	engine := testEngine(store)
	engine.Interval = time.Hour
	// The manual request must run even before the initial staggered fast job.
	store.request.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{}, 1)
	done := make(chan struct{})
	var running, overlaps atomic.Int32
	go func() {
		defer close(done)
		engine.runScheduler(ctx, func(job collectionJob) bool {
			if running.Add(1) > 1 {
				overlaps.Add(1)
			}
			defer running.Add(-1)
			if job.requestID == 99 {
				if !job.neighbors {
					t.Error("manual request is not a neighbor job")
				}
				store.request.Store(false)
				select {
				case ready <- struct{}{}:
				default:
				}
			}
			time.Sleep(time.Millisecond)
			return true
		})
	}()
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("manual request waited for scheduled interval")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not stop")
	}
	if overlaps.Load() != 0 {
		t.Fatal("same device ran overlapping jobs")
	}
}
