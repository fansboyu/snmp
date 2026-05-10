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
	"snmp-monitor/collector-go/internal/notifier"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, env("DATABASE_URL", "postgres://snmp:snmp@localhost:5432/snmp_monitor?sslmode=disable"))
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer db.Close()

	service := notifier.Service{
		Store: db,
		SMTP: notifier.SMTPConfig{
			Host:     env("SMTP_HOST", ""),
			Port:     intEnv("SMTP_PORT", 587),
			Username: env("SMTP_USERNAME", ""),
			Password: env("SMTP_PASSWORD", ""),
			From:     env("SMTP_FROM", ""),
			TLSMode:  env("SMTP_TLS_MODE", "starttls"),
			Timeout:  durationEnv("SMTP_TIMEOUT_SECONDS", 10),
		},
		PollInterval:      durationEnv("SMTP_POLL_INTERVAL_SECONDS", 10),
		BatchSize:         intEnv("SMTP_BATCH_SIZE", 50),
		MaxRetries:        intEnv("SMTP_MAX_RETRIES", 3),
		StaleSendingAfter: durationEnv("SMTP_STALE_SENDING_SECONDS", 300),
	}

	log.Println("email notifier started")
	if err := service.Run(ctx); err != nil {
		log.Fatalf("notifier stopped: %v", err)
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
