package configbackup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

type Job struct {
	ID       int64
	DeviceID int64
}

type Profile struct {
	Protocol       string
	Platform       string
	Host           string
	Port           int
	Username       string
	Fingerprint    string
	CredentialText string
	RetentionCount int
}

type Store interface {
	EnqueueScheduled(context.Context) error
	ResetStale(context.Context, time.Duration) error
	Claim(context.Context) (*Job, error)
	LoadProfile(context.Context, int64) (Profile, error)
	LatestHash(context.Context, int64) (string, error)
	SaveVersion(context.Context, int64, int64, string, string, int, bool, int) error
	FailJob(context.Context, int64, string) error
}

type Service struct {
	Store  Store
	Secret string
}

func (service Service) Run(ctx context.Context) error {
	if service.Store == nil || strings.TrimSpace(service.Secret) == "" {
		return errors.New("configuration backup service requires a store and encryption secret")
	}
	if err := service.Store.ResetStale(ctx, 3*time.Minute); err != nil {
		return fmt.Errorf("recover stale configuration backup jobs: %w", err)
	}
	go service.schedule(ctx)
	log.Print("device configuration backup scheduler started (workers=2, protocol=ssh)")
	var workersDone = make(chan struct{}, 2)
	for i := 0; i < cap(workersDone); i++ {
		go func() {
			defer func() { workersDone <- struct{}{} }()
			service.worker(ctx)
		}()
	}
	<-ctx.Done()
	<-workersDone
	<-workersDone
	return nil
}

func (service Service) schedule(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := service.Store.EnqueueScheduled(ctx); err != nil && ctx.Err() == nil {
			log.Printf("configuration backup scheduling failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (service Service) worker(ctx context.Context) {
	for ctx.Err() == nil {
		job, err := service.Store.Claim(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("claim configuration backup job failed: %v", err)
			}
			if !sleep(ctx, 2*time.Second) {
				return
			}
			continue
		}
		if job == nil {
			if !sleep(ctx, 2*time.Second) {
				return
			}
			continue
		}
		service.runJob(ctx, *job)
	}
}

func (service Service) runJob(parent context.Context, job Job) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	profile, err := service.Store.LoadProfile(ctx, job.DeviceID)
	if err != nil {
		service.fail(job.ID, fmt.Errorf("load backup profile: %w", err))
		return
	}
	var credential Credential
	if err := json.Unmarshal([]byte(profile.CredentialText), &credential); err != nil {
		service.fail(job.ID, errors.New("stored SSH credentials are invalid"))
		return
	}
	adapter, err := AdapterFor(profile.Protocol)
	if err != nil {
		service.fail(job.ID, err)
		return
	}
	content, err := adapter.Backup(ctx, Target{
		Host: profile.Host, Port: profile.Port, Username: profile.Username,
		Fingerprint: profile.Fingerprint, Platform: profile.Platform, Credential: credential,
	})
	if err != nil {
		service.fail(job.ID, err)
		return
	}
	previousHash, err := service.Store.LatestHash(ctx, job.DeviceID)
	if err != nil {
		service.fail(job.ID, fmt.Errorf("read previous backup metadata: %w", err))
		return
	}
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	changed := previousHash != "" && previousHash != hash
	encrypted, err := Encrypt(content, service.Secret)
	if err != nil {
		service.fail(job.ID, errors.New("encrypting configuration backup failed"))
		return
	}
	if err := service.Store.SaveVersion(ctx, job.ID, job.DeviceID, hash, encrypted, len(content), changed, profile.RetentionCount); err != nil {
		service.fail(job.ID, fmt.Errorf("save encrypted configuration backup: %w", err))
		return
	}
	log.Printf("configuration backup job %d completed for device %d; bytes=%d changed=%t", job.ID, job.DeviceID, len(content), changed)
}

func (service Service) fail(jobID int64, err error) {
	message := strings.TrimSpace(err.Error())
	if len(message) > 400 {
		message = message[:400]
	}
	if saveErr := service.Store.FailJob(context.Background(), jobID, message); saveErr != nil {
		log.Printf("configuration backup job %d failed (%s); save status failed: %v", jobID, message, saveErr)
		return
	}
	log.Printf("configuration backup job %d failed: %s", jobID, message)
}

func sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
