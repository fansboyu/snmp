package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
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
		Timeout:         durationEnv("SNMP_TIMEOUT_SECONDS", 3),
		Retries:         intEnv("SNMP_RETRIES", 1),
		WorkerCount:     intEnv("WORKER_COUNT", 64),
		DefaultCommunity: env("SNMP_COMMUNITY", "public"),
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

func durationEnv(key string, fallback int) time.Duration {
	return time.Duration(intEnv(key, fallback)) * time.Second
}

