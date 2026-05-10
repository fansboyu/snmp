package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"snmp-monitor/collector-go/internal/database"
	"snmp-monitor/collector-go/internal/discovery"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, env("DATABASE_URL", "postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable"))
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer db.Close()

	service := discovery.Service{
		Store:             db,
		PollInterval:      durationEnv("DISCOVERY_POLL_INTERVAL_SECONDS", 5),
		StaleRunningAfter: durationEnv("DISCOVERY_STALE_RUNNING_SECONDS", 1800),
	}

	log.Println("discovery worker started")
	if err := service.Run(ctx); err != nil {
		log.Fatalf("discovery worker stopped: %v", err)
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
