package database

import (
	"context"
	"snmp-monitor/collector-go/internal/collector"
)

func (store *PostgresStore) ListTopologyRequests(ctx context.Context) ([]collector.TopologyRequest, error) {
	// A crashed process cannot leave requests permanently running.
	_, err := store.pool.Exec(ctx, `update topology_scan_requests set status='failed',reason='采集任务超时或采集器重启，请重新采集',finished_at=now()
 where (status='running' and started_at<now()-interval '2 minutes') or (status='pending' and created_at<now()-interval '10 minutes')`)
	if err != nil {
		return nil, err
	}
	_, err = store.pool.Exec(ctx, `update topology_scan_requests r set status='failed',reason='设备已停用',finished_at=now() from devices d where r.device_id=d.id and not d.enabled and r.status='pending'`)
	if err != nil {
		return nil, err
	}
	rows, err := store.pool.Query(ctx, `select r.id,r.device_id from topology_scan_requests r join devices d on d.id=r.device_id where r.status='pending' and d.enabled order by r.id limit 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := []collector.TopologyRequest{}
	for rows.Next() {
		var r collector.TopologyRequest
		if err := rows.Scan(&r.ID, &r.DeviceID); err != nil {
			return nil, err
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}
func (store *PostgresStore) ClaimTopologyRequest(ctx context.Context, id int64) (bool, error) {
	result, err := store.pool.Exec(ctx, `update topology_scan_requests r set status='running',started_at=now(),reason='正在读取 LLDP/CDP 邻居'
 where r.id=$1 and r.status='pending' and exists(select 1 from devices where id=r.device_id and enabled)`, id)
	return result.RowsAffected() == 1, err
}
func (store *PostgresStore) FinishTopologyRequest(ctx context.Context, id int64, status, reason string) error {
	_, err := store.pool.Exec(ctx, `update topology_scan_requests set status=$2,reason=$3,finished_at=now() where id=$1 and status='running'`, id, status, reason)
	return err
}
