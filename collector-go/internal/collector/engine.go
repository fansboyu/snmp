package collector

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

type Store interface {
	ListEnabledDevices(context.Context) ([]Device, error)
	ListMetrics(context.Context) ([]MetricDefinition, error)
	SaveSamples(context.Context, []MetricSample) error
}

type Engine struct {
	Store            Store
	Interval         time.Duration
	Timeout          time.Duration
	Retries          int
	WorkerCount      int
	DefaultCommunity string
}

func (engine Engine) Run(ctx context.Context) error {
	if err := engine.collectOnce(ctx); err != nil {
		log.Printf("initial collect failed: %v", err)
	}

	ticker := time.NewTicker(engine.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := engine.collectOnce(ctx); err != nil {
				log.Printf("collect failed: %v", err)
			}
		}
	}
}

func (engine Engine) collectOnce(ctx context.Context) error {
	devices, err := engine.Store.ListEnabledDevices(ctx)
	if err != nil {
		return err
	}

	metrics, err := engine.Store.ListMetrics(ctx)
	if err != nil {
		return err
	}

	jobs := make(chan Device)
	var waitGroup sync.WaitGroup

	workerCount := engine.WorkerCount
	if workerCount <= 0 {
		workerCount = 32
	}

	for index := 0; index < workerCount; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for device := range jobs {
				samples := engine.collectDevice(ctx, device, metrics)
				if len(samples) == 0 {
					continue
				}
				if err := engine.Store.SaveSamples(ctx, samples); err != nil {
					log.Printf("save samples for %s failed: %v", device.Host, err)
				}
			}
		}()
	}

	for _, device := range devices {
		select {
		case <-ctx.Done():
			close(jobs)
			waitGroup.Wait()
			return nil
		case jobs <- device:
		}
	}

	close(jobs)
	waitGroup.Wait()
	return nil
}

func (engine Engine) collectDevice(ctx context.Context, device Device, metrics []MetricDefinition) []MetricSample {
	oids := make([]string, 0, len(metrics))
	metricByOID := make(map[string]MetricDefinition, len(metrics))
	for _, metric := range metrics {
		oids = append(oids, metric.OID)
		metricByOID[metric.OID] = metric
	}

	client := &gosnmp.GoSNMP{
		Target:    device.Host,
		Port:      uint16(device.Port),
		Community: community(device, engine.DefaultCommunity),
		Version:   gosnmp.Version2c,
		Timeout:   engine.Timeout,
		Retries:   engine.Retries,
		MaxOids:   32,
	}

	if err := client.Connect(); err != nil {
		log.Printf("connect %s failed: %v", device.Host, err)
		return nil
	}
	defer client.Conn.Close()

	result, err := client.Get(oids)
	if err != nil {
		log.Printf("get %s failed: %v", device.Host, err)
		return nil
	}

	now := time.Now().UTC()
	samples := make([]MetricSample, 0, len(result.Variables))
	for _, variable := range result.Variables {
		metric, ok := metricByOID[variable.Name]
		if !ok {
			continue
		}
		samples = append(samples, MetricSample{
			DeviceID:  device.ID,
			MetricID:  metric.ID,
			Value:     gosnmp.ToBigInt(variable.Value).String(),
			CreatedAt: now,
		})
	}

	return samples
}

func community(device Device, fallback string) string {
	if device.Community != "" {
		return device.Community
	}
	return fallback
}
