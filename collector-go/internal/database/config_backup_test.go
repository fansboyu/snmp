package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestConfigBackupDatabaseLifecycle(t *testing.T) {
	dsn := os.Getenv("CONFIG_BACKUP_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CONFIG_BACKUP_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("config_backup_test_%x", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "drop schema "+schema+" cascade") })
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `create table devices(id bigint primary key, host inet not null, enabled boolean not null default true)`); err != nil {
		t.Fatal(err)
	}
	migrationPath := filepath.Join("..", "..", "..", "postgres", "migrations", "015_device_config_backups.sql")
	migration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("apply migration 015: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into devices(id,host) values(1,'192.0.2.10')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into device_config_backup_profiles(device_id,protocol,platform,username,credential_ciphertext,host_key_fingerprint,enabled,next_backup_at)
		values(1,'ssh','huawei_vrp','readonly','ciphertext','SHA256:test',true,now()-interval '1 second')
	`); err != nil {
		t.Fatal(err)
	}
	store := &PostgresStore{pool: pool}
	if err := store.EnqueueScheduled(ctx); err != nil {
		t.Fatal(err)
	}
	job, err := store.Claim(ctx)
	if err != nil || job == nil || job.DeviceID != 1 {
		t.Fatalf("claim scheduled backup: job=%+v err=%v", job, err)
	}
	profile, err := store.LoadProfile(ctx, job.DeviceID)
	if err != nil || profile.Host != "192.0.2.10" || profile.CredentialText != "ciphertext" {
		t.Fatalf("load profile: profile=%+v err=%v", profile, err)
	}
	if hash, err := store.LatestHash(ctx, 1); err != nil || hash != "" {
		t.Fatalf("initial latest hash = %q, %v", hash, err)
	}
	if err := store.SaveVersion(ctx, job.ID, 1, "hash-1", "encrypted-1", 128, false, 2); err != nil {
		t.Fatalf("save baseline version: %v", err)
	}
	var baseline, changed bool
	if err := pool.QueryRow(ctx, `select baseline,changed from device_config_backup_versions where job_id=$1`, job.ID).Scan(&baseline, &changed); err != nil || !baseline || changed {
		t.Fatalf("baseline state baseline=%t changed=%t err=%v", baseline, changed, err)
	}
	if _, err := pool.Exec(ctx, `insert into device_config_backup_jobs(device_id,trigger_type) values(1,'manual')`); err != nil {
		t.Fatal(err)
	}
	job, err = store.Claim(ctx)
	if err != nil || job == nil {
		t.Fatalf("claim manual backup: %+v %v", job, err)
	}
	if err := store.SaveVersion(ctx, job.ID, 1, "hash-2", "encrypted-2", 129, true, 2); err != nil {
		t.Fatalf("save changed version: %v", err)
	}
	if hash, err := store.LatestHash(ctx, 1); err != nil || hash != "hash-2" {
		t.Fatalf("latest hash = %q, %v", hash, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*)::int from device_config_backup_versions`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("retained version count=%d err=%v", count, err)
	}
	if _, err := pool.Exec(ctx, `insert into device_config_backup_jobs(device_id,trigger_type) values(1,'manual')`); err != nil {
		t.Fatal(err)
	}
	job, err = store.Claim(ctx)
	if err != nil || job == nil {
		t.Fatalf("claim retry fixture: %+v %v", job, err)
	}
	if err := store.FailJob(ctx, job.ID, "test connection failure"); err != nil {
		t.Fatal(err)
	}
	var status string
	var attempts int
	if err := pool.QueryRow(ctx, `select status,attempts from device_config_backup_jobs where id=$1`, job.ID).Scan(&status, &attempts); err != nil || status != "queued" || attempts != 1 {
		t.Fatalf("retry state status=%s attempts=%d err=%v", status, attempts, err)
	}
	if err := store.ResetStale(ctx, 3*time.Minute); err != nil {
		t.Fatal(err)
	}
}
