package collector

import (
	"context"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type HealthCandidate struct {
	Device          Device
	LastActivity    time.Time
	ConfigUpdatedAt time.Time
}
type HealthObservation struct {
	SNMPOK, PingOK, Conclusive bool
	Reason                     string
}
type HealthStore interface {
	ListHealthCandidates(context.Context, time.Duration) ([]HealthCandidate, error)
	SaveHealthObservation(context.Context, int64, HealthObservation, time.Time, time.Time) error
}

// A separate bounded pool confirms reachability even during collection backoff.
// Inability to run ICMP locally is unknown, never proof that a device is down.
func (engine *Engine) runHealthChecks(ctx context.Context, store HealthStore) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		readCtx, cancel := context.WithTimeout(ctx, engine.DatabaseTimeout)
		devices, err := store.ListHealthCandidates(readCtx, 6*time.Minute)
		cancel()
		if err != nil {
			log.Printf("health candidates failed: %v", err)
		} else {
			var wg sync.WaitGroup
			slots := make(chan struct{}, 8)
			for _, candidate := range devices {
				select {
				case slots <- struct{}{}:
				case <-ctx.Done():
					wg.Wait()
					return
				}
				wg.Add(1)
				go func(candidate HealthCandidate) {
					defer wg.Done()
					defer func() { <-slots }()
					probeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
					observation := engine.probeHealth(probeCtx, candidate.Device)
					stop()
					if ctx.Err() != nil {
						return
					}
					writeCtx, finish := context.WithTimeout(ctx, engine.DatabaseTimeout)
					err := store.SaveHealthObservation(writeCtx, candidate.Device.ID, observation, candidate.LastActivity, candidate.ConfigUpdatedAt)
					finish()
					if err != nil {
						log.Printf("health save device=%d failed: %v", candidate.Device.ID, err)
					}
					log.Printf("health probe device=%d snmp_ok=%t ping_ok=%t conclusive=%t", candidate.Device.ID, observation.SNMPOK, observation.PingOK, observation.Conclusive)
				}(candidate)
			}
			wg.Wait()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (engine *Engine) probeHealth(ctx context.Context, device Device) HealthObservation {
	client := engine.snmpClient(device)
	client.Context = ctx
	client.Timeout = 2 * time.Second
	client.Retries = 0
	if err := client.Connect(); err == nil {
		packet, probeErr := client.Get([]string{".1.3.6.1.2.1.1.2.0"})
		client.Conn.Close()
		if probeErr == nil && packet != nil {
			return HealthObservation{SNMPOK: true, Conclusive: true, Reason: "SNMP 可达，但采集数据已过期"}
		}
	}
	// Literal argv prevents shell injection; -- prevents host option injection.
	output, err := exec.CommandContext(ctx, "ping", "-n", "-c", "3", "-W", "1", "--", device.Host).CombinedOutput()
	if err == nil {
		return HealthObservation{PingOK: true, Conclusive: true, Reason: "Ping 可达，但 SNMP 采集异常"}
	}
	if pingFailedConclusively(err, string(output)) {
		return HealthObservation{Conclusive: true, Reason: "SNMP 与 Ping 连续探测失败；请核对 ICMP 策略及网络"}
	}
	return HealthObservation{Reason: "SNMP 未响应，Ping 无法执行或探测结果不确定"}
}

func pingFailedConclusively(err error, output string) bool {
	exit, ok := err.(*exec.ExitError)
	text := strings.ToLower(output)
	return ok && exit.ExitCode() == 1 && !strings.Contains(text, "operation not permitted") && !strings.Contains(text, "permission denied")
}
