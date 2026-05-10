package notifier

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"strings"
	"time"

	"snmp-monitor/collector-go/internal/collector"
)

type Store interface {
	ResetStaleSendingNotifications(context.Context, time.Duration) error
	ClaimPendingNotifications(context.Context, int) ([]collector.AlertNotification, error)
	MarkNotificationSent(context.Context, int64) error
	MarkNotificationFailed(context.Context, int64, string, time.Duration, int) error
}

type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	TLSMode  string
	Timeout  time.Duration
}

type Service struct {
	Store             Store
	SMTP              SMTPConfig
	PollInterval      time.Duration
	BatchSize         int
	MaxRetries        int
	StaleSendingAfter time.Duration
}

func (service Service) Run(ctx context.Context) error {
	if err := service.Store.ResetStaleSendingNotifications(ctx, service.staleSendingAfter()); err != nil {
		log.Printf("reset stale notifications failed: %v", err)
	}

	ticker := time.NewTicker(service.pollInterval())
	defer ticker.Stop()

	for {
		if err := service.processOnce(ctx); err != nil {
			log.Printf("process notifications failed: %v", err)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (service Service) processOnce(ctx context.Context) error {
	notifications, err := service.Store.ClaimPendingNotifications(ctx, service.batchSize())
	if err != nil {
		return err
	}
	for _, notification := range notifications {
		if err := service.send(notification); err != nil {
			delay := retryDelay(notification.RetryCount + 1)
			_ = service.Store.MarkNotificationFailed(ctx, notification.ID, err.Error(), delay, service.maxRetries())
			log.Printf("send notification %d failed: %v", notification.ID, err)
			continue
		}
		if err := service.Store.MarkNotificationSent(ctx, notification.ID); err != nil {
			log.Printf("mark notification %d sent failed: %v", notification.ID, err)
		}
	}
	return nil
}

func (service Service) send(notification collector.AlertNotification) error {
	if strings.TrimSpace(notification.Target) == "" {
		return fmt.Errorf("empty email target")
	}
	if strings.TrimSpace(service.SMTP.Host) == "" {
		return fmt.Errorf("SMTP_HOST is empty")
	}
	if strings.TrimSpace(service.SMTP.From) == "" {
		return fmt.Errorf("SMTP_FROM is empty")
	}

	address := fmt.Sprintf("%s:%d", service.SMTP.Host, service.SMTP.Port)
	message := buildMessage(service.SMTP.From, notification.Target, notification.Subject, notification.Message)
	auth := smtpAuth(service.SMTP)
	switch strings.ToLower(service.SMTP.TLSMode) {
	case "implicit":
		return sendImplicitTLS(address, service.SMTP.Host, service.SMTP.Timeout, auth, service.SMTP.From, []string{notification.Target}, message)
	case "none":
		return smtp.SendMail(address, auth, service.SMTP.From, []string{notification.Target}, message)
	default:
		return smtp.SendMail(address, auth, service.SMTP.From, []string{notification.Target}, message)
	}
}

func sendImplicitTLS(address string, host string, timeout time.Duration, auth smtp.Auth, from string, to []string, message []byte) error {
	dialer := &net.Dialer{Timeout: timeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", address, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err != nil {
		return err
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Quit()

	if auth != nil {
		if err := client.Auth(auth); err != nil {
			return err
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(message); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func smtpAuth(config SMTPConfig) smtp.Auth {
	if config.Username == "" {
		return nil
	}
	return smtp.PlainAuth("", config.Username, config.Password, config.Host)
}

func buildMessage(from string, to string, subject string, body string) []byte {
	if subject == "" {
		subject = "SNMP Monitor Alert"
	}
	headers := []string{
		fmt.Sprintf("From: %s", from),
		fmt.Sprintf("To: %s", to),
		fmt.Sprintf("Subject: %s", subject),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
	}
	return []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body)
}

func retryDelay(retryCount int) time.Duration {
	switch retryCount {
	case 1:
		return time.Minute
	case 2:
		return 5 * time.Minute
	default:
		return 15 * time.Minute
	}
}

func (service Service) pollInterval() time.Duration {
	if service.PollInterval <= 0 {
		return 10 * time.Second
	}
	return service.PollInterval
}

func (service Service) batchSize() int {
	if service.BatchSize <= 0 {
		return 50
	}
	return service.BatchSize
}

func (service Service) maxRetries() int {
	if service.MaxRetries <= 0 {
		return 3
	}
	return service.MaxRetries
}

func (service Service) staleSendingAfter() time.Duration {
	if service.StaleSendingAfter <= 0 {
		return 5 * time.Minute
	}
	return service.StaleSendingAfter
}
