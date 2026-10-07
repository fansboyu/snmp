package collector

import (
	"context"
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type scheduledDevice struct {
	device                 Device
	fastDue, neighborDue   time.Time
	busy, enabled, healthy bool
	failures               int
	revision               uint64
	cancel                 context.CancelFunc
}

type collectionJob struct {
	device    Device
	neighbors bool
	revision  uint64
	ctx       context.Context
}

type collectionResult struct {
	job     collectionJob
	success bool
}

func positiveDuration(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return value
}

// Advance the original schedule, skipping missed slots instead of replaying them.
func nextSlot(due, now time.Time, interval time.Duration) time.Time {
	if due.After(now) {
		return due
	}
	return due.Add((now.Sub(due)/interval + 1) * interval)
}

func failureDelay(interval time.Duration, failures int) time.Duration {
	if failures > 3 {
		failures = 3
	}
	return interval * time.Duration(1<<failures)
}

func (engine *Engine) Run(ctx context.Context) error {
	engine.Interval = positiveDuration(engine.Interval, time.Minute)
	engine.DeviceTimeout = positiveDuration(engine.DeviceTimeout, 45*time.Second)
	engine.NeighborInterval = positiveDuration(engine.NeighborInterval, 10*time.Minute)
	engine.NeighborTimeout = positiveDuration(engine.NeighborTimeout, 15*time.Second)
	engine.RefreshInterval = positiveDuration(engine.RefreshInterval, 5*time.Second)
	engine.DatabaseTimeout = positiveDuration(engine.DatabaseTimeout, 10*time.Second)
	engine.MaintenanceTimeout = positiveDuration(engine.MaintenanceTimeout, 2*time.Minute)
	if engine.WorkerCount <= 0 {
		engine.WorkerCount = 16
	}
	log.Printf("scheduler started: workers=%d interval=%s device_budget=%s neighbors=%s neighbor_budget=%s", engine.WorkerCount, engine.Interval, engine.DeviceTimeout, engine.NeighborInterval, engine.NeighborTimeout)
	return engine.runScheduler(ctx, engine.runCollectionJob)
}

func (engine *Engine) runScheduler(ctx context.Context, execute func(collectionJob) bool) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	jobs := make(chan collectionJob) // No unbounded queue; overdue work remains in device state.
	results := make(chan collectionResult, engine.WorkerCount)
	catalog := make(chan []Device, 1)
	var protected atomic.Bool
	protected.Store(engine.StorageGuard.Path != "")
	workers.Add(2)
	go func() { defer workers.Done(); engine.refreshDevices(ctx, catalog) }()
	go func() { defer workers.Done(); engine.runMaintenance(ctx, &protected) }()
	for n := 0; n < engine.WorkerCount; n++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job := <-jobs:
					success := execute(job)
					select {
					case results <- collectionResult{job, success}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	defer workers.Wait()
	// Cancel before joining workers, including when the parent context is canceled.
	defer cancel()
	states := make(map[int64]*scheduledDevice)
	ticker := time.NewTicker(min(engine.RefreshInterval, 100*time.Millisecond))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case devices := <-catalog:
			now := time.Now()
			for _, state := range states {
				state.enabled = false
			}
			for _, device := range devices {
				state := states[device.ID]
				if state == nil {
					// Stable offsets avoid synchronized full-fleet bursts after restart.
					offset := time.Duration(uint64(device.ID)*2654435761%1000) * engine.Interval / 1000
					state = &scheduledDevice{device: device, fastDue: now.Add(offset), neighborDue: now, revision: 1}
					states[device.ID] = state
				} else if state.device != device {
					if state.cancel != nil {
						state.cancel()
					}
					state.device, state.fastDue, state.neighborDue = device, now, now
					state.revision++
					state.failures = 0
					state.healthy = false
				}
				state.enabled = true
			}
			for id, state := range states {
				if !state.enabled {
					if state.cancel != nil {
						state.cancel()
					}
					if !state.busy {
						delete(states, id)
					}
				}
			}
		case result := <-results:
			state := states[result.job.device.ID]
			if state == nil {
				continue
			}
			state.busy = false
			state.cancel()
			state.cancel = nil
			if !state.enabled {
				delete(states, result.job.device.ID)
				continue
			}
			if state.revision != result.job.revision {
				continue
			}
			if !result.job.neighbors {
				state.healthy = result.success
				if result.success {
					state.failures = 0
				} else {
					state.failures++
					state.fastDue = time.Now().Add(failureDelay(engine.Interval, state.failures))
				}
			}
		case <-ticker.C:
		}
		if protected.Load() {
			continue
		}
		now := time.Now()
		ready := make([]*scheduledDevice, 0, len(states))
		for _, state := range states {
			if state.enabled && !state.busy {
				ready = append(ready, state)
			}
		}
		sort.Slice(ready, func(i, j int) bool { return ready[i].fastDue.Before(ready[j].fastDue) })
		// Fast jobs get first chance at workers; slow jobs use remaining capacity.
		for _, neighbors := range []bool{false, true} {
			for _, state := range ready {
				if state.busy {
					continue
				}
				due, budget := state.fastDue, engine.DeviceTimeout
				if neighbors {
					if !state.healthy || !state.fastDue.After(now) {
						continue
					}
					due, budget = state.neighborDue, engine.NeighborTimeout
				}
				if due.After(now) {
					continue
				}
				jobCtx, stop := context.WithTimeout(ctx, budget)
				job := collectionJob{state.device, neighbors, state.revision, jobCtx}
				select {
				case jobs <- job:
					state.busy, state.cancel = true, stop
					if neighbors {
						state.neighborDue = nextSlot(due, now, engine.NeighborInterval)
					} else {
						state.fastDue = nextSlot(due, now, engine.Interval)
					}
				default:
					stop()
				}
			}
		}
	}
}

func (engine *Engine) refreshDevices(ctx context.Context, catalog chan<- []Device) {
	ticker := time.NewTicker(engine.RefreshInterval)
	defer ticker.Stop()
	for {
		readCtx, cancel := context.WithTimeout(ctx, engine.DatabaseTimeout)
		devices, err := engine.Store.ListEnabledDevices(readCtx)
		cancel()
		if err != nil {
			log.Printf("refresh devices failed: %v", err)
		} else {
			select {
			case catalog <- devices:
			case <-ctx.Done():
				return
			}
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}

// One owner for StorageGuard and all maintenance: no competing cleanup runs.
func (engine *Engine) runMaintenance(ctx context.Context, protected *atomic.Bool) {
	ticker := time.NewTicker(engine.RefreshInterval)
	defer ticker.Stop()
	var cleanupDue, rollupDue time.Time
	for {
		guardCtx, cancel := context.WithTimeout(ctx, engine.MaintenanceTimeout)
		decision := engine.StorageGuard.Evaluate(guardCtx, engine.Store)
		cancel()
		protected.Store(decision.Protected)
		now := time.Now()
		if engine.RollupPolicy.Runnable() && !rollupDue.After(now) {
			workCtx, stop := context.WithTimeout(ctx, engine.MaintenanceTimeout)
			engine.rollupSamples(workCtx)
			stop()
			rollupDue = nextSlot(now, time.Now(), engine.RollupPolicy.Interval)
		}
		if engine.CleanupInterval > 0 && engine.RetentionPolicy.Enabled() && !cleanupDue.After(now) {
			workCtx, stop := context.WithTimeout(ctx, engine.MaintenanceTimeout)
			engine.cleanupOldData(workCtx)
			stop()
			cleanupDue = nextSlot(now, time.Now(), engine.CleanupInterval)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}

func (engine *Engine) runCollectionJob(job collectionJob) bool {
	started := time.Now()
	success := false
	defer func() {
		log.Printf("collection finished: device=%d neighbors=%t success=%t elapsed=%s", job.device.ID, job.neighbors, success, time.Since(started).Round(time.Millisecond))
	}()
	if err := job.ctx.Err(); err != nil {
		return false
	}
	if job.neighbors {
		client := engine.snmpClient(job.device)
		client.Context = job.ctx
		if err := client.Connect(); err != nil {
			return false
		}
		defer client.Conn.Close()
		neighbors := engine.collectNeighbors(job.device, client)
		if job.ctx.Err() != nil {
			return false
		}
		success = engine.Store.SaveNeighbors(job.ctx, job.device.ID, neighbors) == nil
		return success
	}
	metrics, err := engine.Store.ListMetrics(job.ctx, job.device.TemplateID)
	if err != nil {
		log.Printf("list metrics for device=%d failed: %v", job.device.ID, err)
		return false
	}
	// Reserve part of the total deadline for persistence and alert evaluation.
	// A slow walk may leave useful partial samples, which can still be saved.
	networkBudget := engine.DeviceTimeout - min(5*time.Second, engine.DeviceTimeout/5)
	networkCtx, stopNetwork := context.WithTimeout(job.ctx, networkBudget)
	samples, interfaces := engine.collectDevice(networkCtx, job.device, metrics)
	networkComplete := networkCtx.Err() == nil
	stopNetwork()
	// The total budget covers network, persistence and alert evaluation. Expired
	// jobs never start detached writes or release their worker before they exit.
	if job.ctx.Err() != nil {
		return false
	}
	success = networkComplete && len(samples)+len(interfaces) > 0
	if len(samples) > 0 {
		if err := engine.Store.SaveSamples(job.ctx, samples); err != nil {
			log.Printf("save device=%d failed: %v", job.device.ID, err)
			success = false
		}
	}
	if len(interfaces) > 0 {
		if err := engine.Store.SaveInterfaceSamples(job.ctx, interfaces); err != nil {
			log.Printf("save interfaces device=%d failed: %v", job.device.ID, err)
			success = false
		}
	}
	if err := engine.evaluateAlerts(job.ctx, job.device, samples, interfaces); err != nil {
		log.Printf("evaluate alerts device=%d failed: %v", job.device.ID, err)
	}
	if job.ctx.Err() != nil {
		success = false
	}
	return success
}
