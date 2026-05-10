package collector

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

type Store interface {
	ListEnabledDevices(context.Context) ([]Device, error)
	ListMetrics(context.Context, int64) ([]MetricDefinition, error)
	SaveSamples(context.Context, []MetricSample) error
	UpsertInterface(context.Context, InterfaceInfo) (int64, error)
	SaveInterfaceSamples(context.Context, []InterfaceMetricSample) error
	ListAlertRules(context.Context) ([]AlertRule, error)
	UpsertAlertEvent(context.Context, AlertEvent) error
	ResolveAlertEvent(context.Context, int64, int64, int64, string) error
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
				metrics, err := engine.Store.ListMetrics(ctx, device.TemplateID)
				if err != nil {
					log.Printf("list metrics for %s failed: %v", device.Host, err)
					continue
				}
				samples, interfaceSamples := engine.collectDevice(ctx, device, metrics)
				if len(samples) > 0 {
					if err := engine.Store.SaveSamples(ctx, samples); err != nil {
						log.Printf("save samples for %s failed: %v", device.Host, err)
					}
				}
				if len(interfaceSamples) > 0 {
					if err := engine.Store.SaveInterfaceSamples(ctx, interfaceSamples); err != nil {
						log.Printf("save interface samples for %s failed: %v", device.Host, err)
					}
				}
				if err := engine.evaluateAlerts(ctx, device, samples, interfaceSamples); err != nil {
					log.Printf("evaluate alerts for %s failed: %v", device.Host, err)
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

func (engine Engine) collectDevice(ctx context.Context, device Device, metrics []MetricDefinition) ([]MetricSample, []InterfaceMetricSample) {
	scalarMetrics := make([]MetricDefinition, 0, len(metrics))
	interfaceMetrics := make([]MetricDefinition, 0, len(metrics))
	for _, metric := range metrics {
		if metric.MetricKind == "interface" {
			interfaceMetrics = append(interfaceMetrics, metric)
			continue
		}
		scalarMetrics = append(scalarMetrics, metric)
	}

	client := engine.snmpClient(device)
	if err := client.Connect(); err != nil {
		log.Printf("connect %s failed: %v", device.Host, err)
		return nil, nil
	}
	defer client.Conn.Close()

	samples := engine.collectScalarMetrics(device, client, scalarMetrics)
	interfaceSamples := engine.collectInterfaceMetrics(ctx, device, client, interfaceMetrics)
	return samples, interfaceSamples
}

func (engine Engine) collectScalarMetrics(device Device, client *gosnmp.GoSNMP, metrics []MetricDefinition) []MetricSample {
	if len(metrics) == 0 {
		return nil
	}

	oids := make([]string, 0, len(metrics))
	metricByOID := make(map[string]MetricDefinition, len(metrics))
	for _, metric := range metrics {
		oids = append(oids, metric.OID)
		metricByOID[oidKey(metric.OID)] = metric
	}

	result, err := client.Get(oids)
	if err != nil {
		log.Printf("get %s failed: %v", device.Host, err)
		return nil
	}

	now := time.Now().UTC()
	samples := make([]MetricSample, 0, len(result.Variables))
	for _, variable := range result.Variables {
		metric, ok := metricByOID[oidKey(variable.Name)]
		if !ok {
			continue
		}
		samples = append(samples, MetricSample{
			DeviceID:   device.ID,
			MetricID:   metric.ID,
			MetricName: metric.Name,
			Value:      snmpValueText(variable.Value),
			CreatedAt:  now,
		})
	}

	return samples
}

func (engine Engine) collectInterfaceMetrics(ctx context.Context, device Device, client *gosnmp.GoSNMP, metrics []MetricDefinition) []InterfaceMetricSample {
	now := time.Now().UTC()
	samples := make([]InterfaceMetricSample, 0)
	interfaceIDs := map[int]int64{}

	for _, metric := range metrics {
		tableOID := metric.TableOID
		if tableOID == "" {
			tableOID = metric.OID
		}

		err := client.Walk(tableOID, func(variable gosnmp.SnmpPDU) error {
			ifIndex, ok := interfaceIndex(tableOID, variable.Name)
			if !ok {
				return nil
			}

			value := snmpValueText(variable.Value)
			info := InterfaceInfo{
				DeviceID:   device.ID,
				IfIndex:    ifIndex,
				LastSeenAt: now,
			}
			switch metric.Name {
			case "ifDescr":
				info.IfDescr = value
			case "ifOperStatus":
				info.OperStatus = value
			}

			interfaceID, ok := interfaceIDs[ifIndex]
			if !ok || info.IfDescr != "" || info.OperStatus != "" {
				var err error
				interfaceID, err = engine.Store.UpsertInterface(ctx, info)
				if err != nil {
					return err
				}
				interfaceIDs[ifIndex] = interfaceID
			}

			samples = append(samples, InterfaceMetricSample{
				DeviceID:    device.ID,
				InterfaceID: interfaceID,
				MetricID:    metric.ID,
				MetricName:  metric.Name,
				IfIndex:     ifIndex,
				Value:       value,
				CreatedAt:   now,
			})
			return nil
		})
		if err != nil {
			log.Printf("walk %s %s failed: %v", device.Host, tableOID, err)
		}
	}

	return samples
}

func (engine Engine) evaluateAlerts(ctx context.Context, device Device, samples []MetricSample, interfaceSamples []InterfaceMetricSample) error {
	rules, err := engine.Store.ListAlertRules(ctx)
	if err != nil {
		return err
	}

	for _, rule := range rules {
		if rule.DeviceID > 0 && rule.DeviceID != device.ID {
			continue
		}
		switch rule.RuleType {
		case "cpu_threshold":
			engine.evaluateCPUAlert(ctx, device, rule, samples)
		case "interface_down":
			engine.evaluateInterfaceDownAlert(ctx, device, rule, interfaceSamples)
		}
	}
	return nil
}

func (engine Engine) evaluateCPUAlert(ctx context.Context, device Device, rule AlertRule, samples []MetricSample) {
	for _, sample := range samples {
		if rule.MetricName != "" && sample.MetricName != rule.MetricName {
			continue
		}
		if !strings.Contains(strings.ToLower(sample.MetricName), "cpu") {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(sample.Value), 64)
		if err != nil {
			continue
		}
		triggered := compare(value, rule.Operator, rule.Threshold)
		title := "CPU 使用率超过阈值"
		if triggered {
			_ = engine.Store.UpsertAlertEvent(ctx, AlertEvent{
				RuleID:    rule.ID,
				DeviceID:  device.ID,
				Severity:  severity(rule.Severity),
				Title:     title,
				Message:   fmt.Sprintf("%s CPU 使用率 %.2f%%，阈值 %.2f%%", device.Name, value, rule.Threshold),
				Value:     sample.Value,
				CreatedAt: sample.CreatedAt,
			})
			continue
		}
		_ = engine.Store.ResolveAlertEvent(ctx, rule.ID, device.ID, 0, title)
	}
}

func (engine Engine) evaluateInterfaceDownAlert(ctx context.Context, device Device, rule AlertRule, samples []InterfaceMetricSample) {
	for _, sample := range samples {
		if sample.MetricName != "ifOperStatus" {
			continue
		}
		if rule.InterfaceID > 0 && rule.InterfaceID != sample.InterfaceID {
			continue
		}
		title := "接口状态 Down"
		if strings.TrimSpace(sample.Value) == "2" || strings.EqualFold(sample.Value, "down") {
			_ = engine.Store.UpsertAlertEvent(ctx, AlertEvent{
				RuleID:      rule.ID,
				DeviceID:    device.ID,
				InterfaceID: sample.InterfaceID,
				Severity:    severity(rule.Severity),
				Title:       title,
				Message:     fmt.Sprintf("%s ifIndex %d 接口处于 Down 状态", device.Name, sample.IfIndex),
				Value:       sample.Value,
				CreatedAt:   sample.CreatedAt,
			})
			continue
		}
		_ = engine.Store.ResolveAlertEvent(ctx, rule.ID, device.ID, sample.InterfaceID, title)
	}
}

func compare(value float64, operator string, threshold float64) bool {
	switch operator {
	case ">=":
		return value >= threshold
	case "<":
		return value < threshold
	case "<=":
		return value <= threshold
	case "=":
		return value == threshold
	default:
		return value > threshold
	}
}

func severity(value string) string {
	if value == "" {
		return "warning"
	}
	return value
}

func (engine Engine) snmpClient(device Device) *gosnmp.GoSNMP {
	client := &gosnmp.GoSNMP{
		Target:    device.Host,
		Port:      uint16(device.Port),
		Community: community(device, engine.DefaultCommunity),
		Version:   gosnmp.Version2c,
		Timeout:   engine.Timeout,
		Retries:   engine.Retries,
		MaxOids:   32,
	}

	if strings.TrimSpace(device.SNMPVersion) == "3" {
		client.Version = gosnmp.Version3
		client.SecurityModel = gosnmp.UserSecurityModel
		client.MsgFlags = snmpV3SecurityLevel(device.SNMPV3SecurityLevel)
		client.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 device.SNMPV3Username,
			AuthenticationProtocol:   snmpV3AuthProtocol(device.SNMPV3AuthProtocol),
			AuthenticationPassphrase: device.SNMPV3AuthPassphrase,
			PrivacyProtocol:          snmpV3PrivProtocol(device.SNMPV3PrivProtocol),
			PrivacyPassphrase:        device.SNMPV3PrivPassphrase,
		}
		client.ContextName = device.SNMPV3ContextName
	}

	return client
}

func snmpV3SecurityLevel(value string) gosnmp.SnmpV3MsgFlags {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "authnopriv", "auth_no_priv":
		return gosnmp.AuthNoPriv
	case "authpriv", "auth_priv":
		return gosnmp.AuthPriv
	default:
		return gosnmp.NoAuthNoPriv
	}
}

func snmpV3AuthProtocol(value string) gosnmp.SnmpV3AuthProtocol {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "MD5":
		return gosnmp.MD5
	case "SHA", "SHA1":
		return gosnmp.SHA
	case "SHA224":
		return gosnmp.SHA224
	case "SHA256":
		return gosnmp.SHA256
	case "SHA384":
		return gosnmp.SHA384
	case "SHA512":
		return gosnmp.SHA512
	default:
		return gosnmp.NoAuth
	}
}

func snmpV3PrivProtocol(value string) gosnmp.SnmpV3PrivProtocol {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "DES":
		return gosnmp.DES
	case "AES", "AES128":
		return gosnmp.AES
	case "AES192":
		return gosnmp.AES192
	case "AES256":
		return gosnmp.AES256
	case "AES192C":
		return gosnmp.AES192C
	case "AES256C":
		return gosnmp.AES256C
	default:
		return gosnmp.NoPriv
	}
}

func interfaceIndex(tableOID string, variableOID string) (int, bool) {
	suffix := strings.TrimPrefix(oidKey(variableOID), oidKey(tableOID))
	suffix = strings.TrimPrefix(suffix, ".")
	if suffix == "" || strings.Contains(suffix, ".") {
		return 0, false
	}
	index, err := strconv.Atoi(suffix)
	return index, err == nil
}

func oidKey(oid string) string {
	return strings.TrimLeft(oid, ".")
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

func community(device Device, fallback string) string {
	if device.Community != "" {
		return device.Community
	}
	return fallback
}
