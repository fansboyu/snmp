package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"snmp-monitor/collector-go/internal/collector"
	"snmp-monitor/collector-go/internal/database"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, env("DATABASE_URL", "postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable"))
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer db.Close()

	engine := collector.Engine{
		Store:           db,
		Interval:        durationEnv("COLLECT_INTERVAL_SECONDS", 60),
		CleanupInterval: durationEnv("CLEANUP_INTERVAL_SECONDS", 3600),
		RetentionPolicy: collector.RetentionPolicy{
			MetricSamplesDays:    intEnv("METRIC_SAMPLE_RETENTION_DAYS", 30),
			InterfaceSamplesDays: intEnv("INTERFACE_SAMPLE_RETENTION_DAYS", 30),
			ResolvedAlertsDays:   intEnv("RESOLVED_ALERT_RETENTION_DAYS", 90),
			BatchSize:            intEnv("CLEANUP_BATCH_SIZE", 5000),
		},
		Timeout:          durationEnv("SNMP_TIMEOUT_SECONDS", 3),
		Retries:          intEnv("SNMP_RETRIES", 1),
		WorkerCount:      intEnv("WORKER_COUNT", 64),
		MaxRepetitions:   uint32Env("GETBULK_MAX_REPETITIONS", 25),
		DefaultCommunity: env("SNMP_COMMUNITY", "public"),
		Notifications: collector.NotificationSettings{
			Enabled:       boolEnv("ALERT_EMAIL_ENABLED", false),
			Targets:       listEnv("ALERT_EMAIL_TO"),
			SendResolved:  boolEnv("ALERT_EMAIL_SEND_RESOLVED", true),
			SubjectPrefix: env("ALERT_EMAIL_SUBJECT_PREFIX", "[SNMP Monitor]"),
		},
	}

	log.Println("collector started")
	if err := engine.Run(ctx); err != nil {
		log.Fatalf("collector stopped: %v", err)
	}
}

func env(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func intEnv(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}

func uint32Env(key string, fallback uint32) uint32 {
	value := intEnv(key, int(fallback))
	if value < 0 {
		return fallback
	}
	return uint32(value)
}

func boolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func listEnv(key string) []string {
	raw := os.Getenv(key)
	if raw == "" {
		return nil
	}
	var values []string
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			values = append(values, item)
		}
	}
	return values
}

func durationEnv(key string, fallback int) time.Duration {
	return time.Duration(intEnv(key, fallback)) * time.Second
}
