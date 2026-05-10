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
	UpsertAlertEvent(context.Context, AlertEvent) (int64, bool, error)
	ResolveAlertEvent(context.Context, int64, int64, int64, string) (*AlertEvent, error)
	CreateAlertNotification(context.Context, AlertNotification) error
	CleanupOldData(context.Context, RetentionPolicy) (CleanupStats, error)
}

type Engine struct {
	Store            Store
	Interval         time.Duration
	CleanupInterval  time.Duration
	RetentionPolicy  RetentionPolicy
	Timeout          time.Duration
	Retries          int
	WorkerCount      int
	MaxRepetitions   uint32
	DefaultCommunity string
	Notifications    NotificationSettings
}

func (engine Engine) Run(ctx context.Context) error {
	if err := engine.collectOnce(ctx); err != nil {
		log.Printf("initial collect failed: %v", err)
	}

	ticker := time.NewTicker(engine.Interval)
	defer ticker.Stop()

	var cleanupTicker *time.Ticker
	if engine.CleanupInterval > 0 && engine.RetentionPolicy.Enabled() {
		cleanupTicker = time.NewTicker(engine.CleanupInterval)
		defer cleanupTicker.Stop()
		engine.cleanupOldData(ctx)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := engine.collectOnce(ctx); err != nil {
				log.Printf("collect failed: %v", err)
			}
		case <-cleanupChan(cleanupTicker):
			engine.cleanupOldData(ctx)
		}
	}
}

func cleanupChan(ticker *time.Ticker) <-chan time.Time {
	if ticker == nil {
		return nil
	}
	return ticker.C
}

func (engine Engine) cleanupOldData(ctx context.Context) {
	stats, err := engine.Store.CleanupOldData(ctx, engine.RetentionPolicy)
	if err != nil {
		log.Printf("cleanup old data failed: %v", err)
		return
	}
	if stats.MetricSamples > 0 || stats.InterfaceSamples > 0 || stats.ResolvedAlerts > 0 {
		log.Printf(
			"cleanup old data completed: metric_samples=%d interface_samples=%d resolved_alerts=%d",
			stats.MetricSamples,
			stats.InterfaceSamples,
			stats.ResolvedAlerts,
		)
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

		walkFn := func(variable gosnmp.SnmpPDU) error {
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
		}

		sampleCount := len(samples)
		err := client.BulkWalk(tableOID, walkFn)
		if err != nil {
			samples = samples[:sampleCount]
			log.Printf("bulk walk %s %s failed, fallback to walk: %v", device.Host, tableOID, err)
			if walkErr := client.Walk(tableOID, walkFn); walkErr != nil {
				log.Printf("walk %s %s failed: %v", device.Host, tableOID, walkErr)
			}
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
			engine.upsertAlertEvent(ctx, AlertEvent{
				RuleID:     rule.ID,
				DeviceID:   device.ID,
				Severity:   severity(rule.Severity),
				Title:      title,
				Message:    fmt.Sprintf("%s CPU 使用率 %.2f%%，阈值 %.2f%%", device.Name, value, rule.Threshold),
				Value:      sample.Value,
				CreatedAt:  sample.CreatedAt,
				DeviceName: device.Name,
			})
			continue
		}
		engine.resolveAlertEvent(ctx, rule.ID, device.ID, 0, title)
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
			engine.upsertAlertEvent(ctx, AlertEvent{
				RuleID:      rule.ID,
				DeviceID:    device.ID,
				InterfaceID: sample.InterfaceID,
				Severity:    severity(rule.Severity),
				Title:       title,
				Message:     fmt.Sprintf("%s ifIndex %d 接口处于 Down 状态", device.Name, sample.IfIndex),
				Value:       sample.Value,
				CreatedAt:   sample.CreatedAt,
				DeviceName:  device.Name,
			})
			continue
		}
		engine.resolveAlertEvent(ctx, rule.ID, device.ID, sample.InterfaceID, title)
	}
}

func (engine Engine) upsertAlertEvent(ctx context.Context, event AlertEvent) {
	eventID, created, err := engine.Store.UpsertAlertEvent(ctx, event)
	if err != nil {
		log.Printf("upsert alert event failed: %v", err)
		return
	}
	if created {
		event.ID = eventID
		engine.queueAlertNotifications(ctx, event, "triggered")
	}
}

func (engine Engine) resolveAlertEvent(ctx context.Context, ruleID int64, deviceID int64, interfaceID int64, title string) {
	event, err := engine.Store.ResolveAlertEvent(ctx, ruleID, deviceID, interfaceID, title)
	if err != nil {
		log.Printf("resolve alert event failed: %v", err)
		return
	}
	if event != nil && engine.Notifications.SendResolved {
		engine.queueAlertNotifications(ctx, *event, "resolved")
	}
}

func (engine Engine) queueAlertNotifications(ctx context.Context, event AlertEvent, action string) {
	if !engine.Notifications.Enabled || len(engine.Notifications.Targets) == 0 || event.ID == 0 {
		return
	}
	subject := alertNotificationSubject(engine.Notifications.SubjectPrefix, event, action)
	message := alertNotificationMessage(event, action)
	for _, target := range engine.Notifications.Targets {
		target = strings.TrimSpace(target)
		if target == "" {
			continue
		}
		err := engine.Store.CreateAlertNotification(ctx, AlertNotification{
			EventID: event.ID,
			Channel: "email",
			Target:  target,
			Subject: subject,
			Message: message,
		})
		if err != nil {
			log.Printf("queue alert notification failed: %v", err)
		}
	}
}

func alertNotificationSubject(prefix string, event AlertEvent, action string) string {
	if prefix == "" {
		prefix = "[SNMP Monitor]"
	}
	status := "Alert"
	if action == "resolved" {
		status = "Resolved"
	}
	deviceName := event.DeviceName
	if deviceName == "" {
		deviceName = fmt.Sprintf("device-%d", event.DeviceID)
	}
	return fmt.Sprintf("%s[%s][%s] %s - %s", prefix, status, event.Severity, event.Title, deviceName)
}

func alertNotificationMessage(event AlertEvent, action string) string {
	status := "告警触发"
	if action == "resolved" {
		status = "告警恢复"
	}
	lines := []string{
		fmt.Sprintf("状态: %s", status),
		fmt.Sprintf("级别: %s", event.Severity),
		fmt.Sprintf("设备: %s", event.DeviceName),
		fmt.Sprintf("标题: %s", event.Title),
		fmt.Sprintf("详情: %s", event.Message),
		fmt.Sprintf("当前值: %s", event.Value),
		fmt.Sprintf("触发时间: %s", event.CreatedAt.Format(time.RFC3339)),
	}
	if !event.ResolvedAt.IsZero() {
		lines = append(lines, fmt.Sprintf("恢复时间: %s", event.ResolvedAt.Format(time.RFC3339)))
	}
	return strings.Join(lines, "\n")
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
	if engine.MaxRepetitions > 0 {
		client.MaxRepetitions = engine.MaxRepetitions
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
