package main

import (
	"context"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"snmp-monitor/collector-go/internal/syslog"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL := env("DATABASE_URL", "postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable")
	if _, err := url.Parse(databaseURL); err != nil {
		log.Fatalf("invalid DATABASE_URL: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("configure database pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("connect database: %v", err)
	}

	config := syslog.Config{
		BindAddress:       env("SYSLOG_BIND_ADDRESS", "0.0.0.0"),
		Port:              intEnv("SYSLOG_UDP_PORT", 1514),
		HostPort:          intEnv("SYSLOG_ADVERTISED_PORT", 514),
		MaxMessageBytes:   intEnv("SYSLOG_MAX_MESSAGE_BYTES", 8192),
		QueueSize:         intEnv("SYSLOG_QUEUE_SIZE", 5000),
		BatchSize:         intEnv("SYSLOG_BATCH_SIZE", 200),
		FlushInterval:     time.Duration(intEnv("SYSLOG_FLUSH_INTERVAL_MS", 500)) * time.Millisecond,
		RetentionDays:     intEnv("SYSLOG_RETENTION_DAYS", 30),
		RetentionInterval: time.Duration(intEnv("SYSLOG_RETENTION_INTERVAL_SECONDS", 3600)) * time.Second,
	}
	if config.Port < 1 || config.Port > 65535 || config.HostPort < 1 || config.HostPort > 65535 || config.MaxMessageBytes < 256 || config.MaxMessageBytes > 65535 || config.QueueSize < 1 || config.BatchSize < 1 || config.BatchSize > 1000 || config.RetentionDays < 1 {
		log.Fatal("invalid syslog collector configuration")
	}
	service := syslog.New(config, pool)
	if err := service.Run(ctx); err != nil {
		log.Fatalf("syslog collector stopped: %v", err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func intEnv(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}
