package database

import (
	"context"
	"errors"
	"time"

	"snmp-monitor/collector-go/internal/configbackup"

	"github.com/jackc/pgx/v5"
)

func (store *PostgresStore) EnqueueScheduled(ctx context.Context) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		select p.device_id, p.interval_hours
		from device_config_backup_profiles p
		join devices d on d.id=p.device_id
		where p.enabled and d.enabled and p.next_backup_at <= now()
		order by p.next_backup_at
		limit 20
		for update of p skip locked
	`)
	if err != nil {
		return err
	}
	type dueProfile struct {
		id       int64
		interval int
	}
	var due []dueProfile
	for rows.Next() {
		var item dueProfile
		if err := rows.Scan(&item.id, &item.interval); err != nil {
			rows.Close()
			return err
		}
		due = append(due, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range due {
		_, err := tx.Exec(ctx, `
			insert into device_config_backup_jobs(device_id, trigger_type)
			values($1, 'scheduled') on conflict do nothing
		`, item.id)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			update device_config_backup_profiles
			set next_backup_at=now()+make_interval(hours => $2), updated_at=now()
			where device_id=$1
		`, item.id, item.interval)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (store *PostgresStore) ResetStale(ctx context.Context, staleAfter time.Duration) error {
	_, err := store.pool.Exec(ctx, `
		update device_config_backup_jobs
		set status=case when attempts >= 3 then 'failed' else 'queued' end,
			started_at=null,
			finished_at=case when attempts >= 3 then now() else null end,
			error_message='worker stopped before finishing the backup',
			next_attempt_at=now()+interval '10 seconds', updated_at=now()
		where status='running' and updated_at < now()-make_interval(secs => $1)
	`, int(staleAfter.Seconds()))
	return err
}

func (store *PostgresStore) Claim(ctx context.Context) (*configbackup.Job, error) {
	var job configbackup.Job
	err := store.pool.QueryRow(ctx, `
		with picked as (
			select id from device_config_backup_jobs
			where status='queued' and next_attempt_at <= now() and attempts < 3
			order by requested_at limit 1 for update skip locked
		)
		update device_config_backup_jobs j
		set status='running', attempts=attempts+1, started_at=now(), finished_at=null,
			error_message=null, updated_at=now()
		from picked where j.id=picked.id
		returning j.id, j.device_id
	`).Scan(&job.ID, &job.DeviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (store *PostgresStore) LoadProfile(ctx context.Context, deviceID int64) (configbackup.Profile, error) {
	var profile configbackup.Profile
	err := store.pool.QueryRow(ctx, `
		select p.protocol, p.platform, host(d.host), p.port, p.username,
			p.host_key_fingerprint, p.credential_ciphertext, p.retention_count
		from device_config_backup_profiles p
		join devices d on d.id=p.device_id
		where p.device_id=$1 and d.enabled
	`, deviceID).Scan(
		&profile.Protocol, &profile.Platform, &profile.Host, &profile.Port, &profile.Username,
		&profile.Fingerprint, &profile.CredentialText, &profile.RetentionCount,
	)
	return profile, err
}

func (store *PostgresStore) LatestHash(ctx context.Context, deviceID int64) (string, error) {
	var hash string
	err := store.pool.QueryRow(ctx, `
		select sha256 from device_config_backup_versions
		where device_id=$1 order by created_at desc, id desc limit 1
	`, deviceID).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return hash, err
}

func (store *PostgresStore) SaveVersion(ctx context.Context, jobID, deviceID int64, hash, encrypted string, size int, changed bool, retention int) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var previousID *int64
	if err := tx.QueryRow(ctx, `
		select id from device_config_backup_versions where device_id=$1
		order by created_at desc, id desc limit 1 for update
	`, deviceID).Scan(&previousID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var versionID int64
	if err := tx.QueryRow(ctx, `
		insert into device_config_backup_versions(device_id,job_id,sha256,encrypted_content,size_bytes,baseline,changed,previous_version_id)
		values($1,$2,$3,$4,$5,$6,$7,$8) returning id
	`, deviceID, jobID, hash, encrypted, size, previousID == nil, changed, previousID).Scan(&versionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		update device_config_backup_jobs set status='succeeded', version_id=$2,
			finished_at=now(), updated_at=now(), error_message=null where id=$1
	`, jobID, versionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		update device_config_backup_profiles set last_backup_at=now(), updated_at=now() where device_id=$1
	`, deviceID); err != nil {
		return err
	}
	if retention < 2 {
		retention = 2
	}
	if _, err := tx.Exec(ctx, `
		delete from device_config_backup_versions
		where device_id=$1 and id not in (
			select id from device_config_backup_versions where device_id=$1
			order by created_at desc, id desc limit $2
		)
	`, deviceID, retention); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (store *PostgresStore) FailJob(ctx context.Context, jobID int64, message string) error {
	_, err := store.pool.Exec(ctx, `
		update device_config_backup_jobs
		set status=case when attempts < 3 then 'queued' else 'failed' end,
			error_message=$2,
			finished_at=case when attempts < 3 then null else now() end,
			next_attempt_at=now()+make_interval(secs => case when attempts=1 then 10 when attempts=2 then 30 else 0 end),
			updated_at=now()
		where id=$1 and status='running'
	`, jobID, message)
	return err
}
