package collector

import (
	"context"
	"log"
	"time"
)

type DiskUsage struct {
	Path        string
	TotalBytes  uint64
	FreeBytes   uint64
	UsedPercent float64
}

type StorageGuard struct {
	Path               string
	WarningPercent     float64
	ReadOnlyPercent    float64
	CleanupPercent     float64
	RecoveryPercent    float64
	CleanupCooldown    time.Duration
	EmergencyRetention RetentionPolicy

	protected   bool
	lastCleanup time.Time
}

type StorageDecision struct {
	Enabled      bool
	Protected    bool
	CleanupRan   bool
	Usage        DiskUsage
	CleanupStats CleanupStats
}

func (guard *StorageGuard) Evaluate(ctx context.Context, store Store) StorageDecision {
	decision := StorageDecision{Enabled: guard.Path != ""}
	if guard.Path == "" {
		return decision
	}

	usage, err := diskUsage(guard.Path)
	if err != nil {
		log.Printf("storage guard check failed for %s: %v", guard.Path, err)
		return decision
	}
	decision.Usage = usage

	warningPercent := thresholdOrDefault(guard.WarningPercent, 85)
	readOnlyPercent := thresholdOrDefault(guard.ReadOnlyPercent, 90)
	cleanupPercent := thresholdOrDefault(guard.CleanupPercent, readOnlyPercent)
	recoveryPercent := thresholdOrDefault(guard.RecoveryPercent, 85)

	if usage.UsedPercent >= warningPercent {
		log.Printf(
			"storage usage warning: path=%s used=%.2f%% free=%d total=%d",
			usage.Path,
			usage.UsedPercent,
			usage.FreeBytes,
			usage.TotalBytes,
		)
	}

	if usage.UsedPercent >= cleanupPercent && guard.EmergencyRetention.Enabled() && guard.canRunCleanup() {
		stats, err := store.CleanupOldData(ctx, guard.EmergencyRetention)
		if err != nil {
			log.Printf("emergency cleanup failed: %v", err)
		} else {
			guard.lastCleanup = time.Now()
			decision.CleanupRan = true
			decision.CleanupStats = stats
			log.Printf(
				"emergency cleanup completed: metric_samples=%d interface_samples=%d resolved_alerts=%d alert_notifications=%d discovery_jobs=%d",
				stats.MetricSamples,
				stats.InterfaceSamples,
				stats.ResolvedAlerts,
				stats.AlertNotifications,
				stats.DiscoveryJobs,
			)
		}
	}

	if usage.UsedPercent >= readOnlyPercent {
		if !guard.protected {
			log.Printf("storage protection enabled: path=%s used=%.2f%% threshold=%.2f%%", usage.Path, usage.UsedPercent, readOnlyPercent)
		}
		guard.protected = true
	} else if guard.protected && usage.UsedPercent <= recoveryPercent {
		log.Printf("storage protection disabled: path=%s used=%.2f%% recovery=%.2f%%", usage.Path, usage.UsedPercent, recoveryPercent)
		guard.protected = false
	}

	decision.Protected = guard.protected
	return decision
}

func (guard *StorageGuard) canRunCleanup() bool {
	if guard.CleanupCooldown <= 0 {
		guard.CleanupCooldown = 10 * time.Minute
	}
	return guard.lastCleanup.IsZero() || time.Since(guard.lastCleanup) >= guard.CleanupCooldown
}

func thresholdOrDefault(value float64, fallback float64) float64 {
	if value <= 0 {
		return fallback
	}
	return value
}
