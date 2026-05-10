package discovery

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gosnmp/gosnmp"
)

type Store interface {
	ResetStaleDiscoveryJobs(context.Context, time.Duration) error
	ClaimDiscoveryJob(context.Context) (*Job, error)
	SetDiscoveryJobTotal(context.Context, int64, int) error
	SaveDiscoveryResult(context.Context, Result) error
	IncrementDiscoveryProgress(context.Context, int64, int) (string, error)
	FinishDiscoveryJob(context.Context, int64, string, string) error
}

type Service struct {
	Store             Store
	PollInterval      time.Duration
	StaleRunningAfter time.Duration
}

func (service Service) Run(ctx context.Context) error {
	if err := service.Store.ResetStaleDiscoveryJobs(ctx, service.staleRunningAfter()); err != nil {
		log.Printf("reset stale discovery jobs failed: %v", err)
	}

	ticker := time.NewTicker(service.pollInterval())
	defer ticker.Stop()

	for {
		if err := service.processOnce(ctx); err != nil {
			log.Printf("process discovery job failed: %v", err)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (service Service) processOnce(ctx context.Context) error {
	job, err := service.Store.ClaimDiscoveryJob(ctx)
	if err != nil || job == nil {
		return err
	}

	log.Printf("discovery job %d started: cidr=%s port=%d concurrency=%d", job.ID, job.CIDR, job.Port, job.Concurrency)
	if err := service.scanJob(ctx, *job); err != nil {
		_ = service.Store.FinishDiscoveryJob(ctx, job.ID, "failed", err.Error())
		return err
	}
	return nil
}

func (service Service) scanJob(ctx context.Context, job Job) error {
	hosts, err := expandCIDR(job.CIDR)
	if err != nil {
		return err
	}
	if job.TotalHosts != len(hosts) {
		if err := service.Store.SetDiscoveryJobTotal(ctx, job.ID, len(hosts)); err != nil {
			return err
		}
	}

	workerCount := job.Concurrency
	if workerCount <= 0 {
		workerCount = 16
	}
	if workerCount > len(hosts) {
		workerCount = len(hosts)
	}

	hostJobs := make(chan string)
	var waitGroup sync.WaitGroup
	var canceled int32
	var errorMu sync.Mutex
	var firstErr error

	setFirstErr := func(err error) {
		if err == nil {
			return
		}
		errorMu.Lock()
		defer errorMu.Unlock()
		if firstErr == nil {
			firstErr = err
		}
	}

	for index := 0; index < workerCount; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for host := range hostJobs {
				if atomic.LoadInt32(&canceled) == 1 {
					continue
				}
				result, ok := scanHost(job, host)
				discoveredDelta := 0
				if ok {
					discoveredDelta = 1
					if err := service.Store.SaveDiscoveryResult(ctx, result); err != nil {
						setFirstErr(err)
					}
				}
				status, err := service.Store.IncrementDiscoveryProgress(ctx, job.ID, discoveredDelta)
				if err != nil {
					setFirstErr(err)
					atomic.StoreInt32(&canceled, 1)
					continue
				}
				if status == "canceled" {
					atomic.StoreInt32(&canceled, 1)
				}
			}
		}()
	}

sendHosts:
	for _, host := range hosts {
		if atomic.LoadInt32(&canceled) == 1 {
			break
		}
		select {
		case <-ctx.Done():
			atomic.StoreInt32(&canceled, 1)
			break sendHosts
		case hostJobs <- host:
		}
	}
	close(hostJobs)
	waitGroup.Wait()

	if firstErr != nil {
		return firstErr
	}
	if atomic.LoadInt32(&canceled) == 1 {
		return service.Store.FinishDiscoveryJob(ctx, job.ID, "canceled", "")
	}
	return service.Store.FinishDiscoveryJob(ctx, job.ID, "completed", "")
}

func scanHost(job Job, host string) (Result, bool) {
	startedAt := time.Now()
	client := &gosnmp.GoSNMP{
		Target:    host,
		Port:      uint16(job.Port),
		Community: job.Community,
		Version:   gosnmp.Version2c,
		Timeout:   time.Duration(job.TimeoutMS) * time.Millisecond,
		Retries:   job.Retries,
		MaxOids:   3,
	}
	if err := client.Connect(); err != nil {
		return Result{}, false
	}
	defer client.Conn.Close()

	packet, err := client.Get([]string{
		".1.3.6.1.2.1.1.5.0",
		".1.3.6.1.2.1.1.1.0",
		".1.3.6.1.2.1.1.2.0",
	})
	if err != nil {
		return Result{}, false
	}

	result := Result{
		JobID:       job.ID,
		Host:        host,
		Port:        job.Port,
		SNMPVersion: "2c",
		ResponseMS:  int(time.Since(startedAt).Milliseconds()),
		Status:      "discovered",
	}
	for _, variable := range packet.Variables {
		switch oidKey(variable.Name) {
		case "1.3.6.1.2.1.1.5.0":
			result.SysName = snmpValueText(variable.Value)
		case "1.3.6.1.2.1.1.1.0":
			result.SysDescr = snmpValueText(variable.Value)
		case "1.3.6.1.2.1.1.2.0":
			result.SysObjectID = snmpValueText(variable.Value)
		}
	}
	return result, result.SysName != "" || result.SysDescr != "" || result.SysObjectID != ""
}

func expandCIDR(cidr string) ([]string, error) {
	ip, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, err
	}
	ip = ip.To4()
	if ip == nil {
		return nil, fmt.Errorf("only IPv4 CIDR is supported")
	}
	ones, bits := network.Mask.Size()
	if bits != 32 || ones < 24 || ones > 32 {
		return nil, fmt.Errorf("CIDR must be IPv4 /24 or smaller")
	}

	start := binary.BigEndian.Uint32(ip)
	count := uint32(1) << uint32(32-ones)
	hosts := make([]string, 0, count)
	buffer := make(net.IP, 4)
	for offset := uint32(0); offset < count; offset++ {
		binary.BigEndian.PutUint32(buffer, start+offset)
		hosts = append(hosts, buffer.String())
	}
	return hosts, nil
}

func snmpValueText(value interface{}) string {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case string:
		return typed
	case nil:
		return ""
	default:
		if bigint := gosnmp.ToBigInt(value); bigint != nil {
			return bigint.String()
		}
		return fmt.Sprint(typed)
	}
}

func oidKey(oid string) string {
	for len(oid) > 0 && oid[0] == '.' {
		oid = oid[1:]
	}
	return oid
}

func (service Service) pollInterval() time.Duration {
	if service.PollInterval <= 0 {
		return 5 * time.Second
	}
	return service.PollInterval
}

func (service Service) staleRunningAfter() time.Duration {
	if service.StaleRunningAfter <= 0 {
		return 30 * time.Minute
	}
	return service.StaleRunningAfter
}

func IntEnv(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
