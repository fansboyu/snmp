package collector

import (
	"context"
	"fmt"
	"log"
	"math"
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
	SaveNeighbors(context.Context, int64, []NeighborInfo) error
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
	StorageGuard     StorageGuard
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
	if stats.MetricSamples > 0 ||
		stats.InterfaceSamples > 0 ||
		stats.ResolvedAlerts > 0 ||
		stats.AlertNotifications > 0 ||
		stats.DiscoveryJobs > 0 {
		log.Printf(
			"cleanup old data completed: metric_samples=%d interface_samples=%d resolved_alerts=%d alert_notifications=%d discovery_jobs=%d",
			stats.MetricSamples,
			stats.InterfaceSamples,
			stats.ResolvedAlerts,
			stats.AlertNotifications,
			stats.DiscoveryJobs,
		)
	}
}

func (engine Engine) collectOnce(ctx context.Context) error {
	decision := engine.StorageGuard.Evaluate(ctx, engine.Store)
	if decision.Protected {
		log.Printf(
			"storage protection active; skip this collection cycle: path=%s used=%.2f%%",
			decision.Usage.Path,
			decision.Usage.UsedPercent,
		)
		return nil
	}

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
	walkMetrics := make([]MetricDefinition, 0, len(metrics))
	interfaceMetrics := make([]MetricDefinition, 0, len(metrics))
	for _, metric := range metrics {
		switch metric.MetricKind {
		case "interface":
			interfaceMetrics = append(interfaceMetrics, metric)
		case "walk":
			walkMetrics = append(walkMetrics, metric)
		default:
			scalarMetrics = append(scalarMetrics, metric)
		}
	}

	client := engine.snmpClient(device)
	if err := client.Connect(); err != nil {
		log.Printf("connect %s failed: %v", device.Host, err)
		return nil, nil
	}
	defer client.Conn.Close()

	samples := engine.collectScalarMetrics(device, client, scalarMetrics)
	samples = append(samples, engine.collectWalkMetrics(device, client, walkMetrics)...)
	interfaceSamples := engine.collectInterfaceMetrics(ctx, device, client, interfaceMetrics)
	neighbors := engine.collectNeighbors(device, client)
	if err := engine.Store.SaveNeighbors(ctx, device.ID, neighbors); err != nil {
		log.Printf("save neighbors for %s failed: %v", device.Host, err)
	}
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
			Value:      scaledSNMPValueText(metric, variable.Value),
			CreatedAt:  now,
		})
	}

	return samples
}

func (engine Engine) collectWalkMetrics(device Device, client *gosnmp.GoSNMP, metrics []MetricDefinition) []MetricSample {
	if len(metrics) == 0 {
		return nil
	}

	now := time.Now().UTC()
	samples := make([]MetricSample, 0, len(metrics))
	for _, metric := range metrics {
		tableOID := metric.TableOID
		if tableOID == "" {
			tableOID = metric.OID
		}

		values := make([]float64, 0)
		walkFn := func(variable gosnmp.SnmpPDU) error {
			value, ok := snmpNumericValue(variable.Value)
			if !ok {
				return nil
			}
			values = append(values, value)
			return nil
		}

		if err := client.BulkWalk(tableOID, walkFn); err != nil {
			values = values[:0]
			log.Printf("bulk walk %s %s failed, fallback to walk: %v", device.Host, tableOID, err)
			if walkErr := client.Walk(tableOID, walkFn); walkErr != nil {
				log.Printf("walk %s %s failed: %v", device.Host, tableOID, walkErr)
				continue
			}
		}
		if len(values) == 0 {
			continue
		}
		samples = append(samples, MetricSample{
			DeviceID:   device.ID,
			MetricID:   metric.ID,
			MetricName: metric.Name,
			Value:      formatMetricFloat(metric, aggregateValues(values, metric.AggregateMethod)*metricScale(metric)),
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

			value := scaledSNMPValueText(metric, variable.Value)
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

func (engine Engine) collectNeighbors(device Device, client *gosnmp.GoSNMP) []NeighborInfo {
	now := time.Now().UTC()
	neighbors := make([]NeighborInfo, 0)
	neighbors = append(neighbors, collectLLDPNeighbors(device, client, now)...)
	neighbors = append(neighbors, collectCDPNeighbors(device, client, now)...)
	return neighbors
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

type lldpNeighborKey struct {
	TimeMark     string
	LocalPortNum string
	RemoteIndex  string
}

type cdpNeighborKey struct {
	IfIndex string
	Index   string
}

type lldpNeighborRow struct {
	LocalPortNum   string
	RemoteChassis  string
	RemotePortID   string
	RemotePortDesc string
	RemoteSysName  string
	RemoteSysDesc  string
	Raw            map[string]string
}

type cdpNeighborRow struct {
	IfIndex        string
	RemoteAddress  string
	RemoteDeviceID string
	RemotePortID   string
	RemotePlatform string
	RemoteCaps     string
	Raw            map[string]string
}

func collectLLDPNeighbors(device Device, client *gosnmp.GoSNMP, now time.Time) []NeighborInfo {
	localPortIDs := walkTextColumn(client, ".1.0.8802.1.1.2.1.3.7.1.3")
	localPortDescs := walkTextColumn(client, ".1.0.8802.1.1.2.1.3.7.1.4")
	if len(localPortIDs) == 0 && len(localPortDescs) == 0 {
		return nil
	}

	rows := map[lldpNeighborKey]*lldpNeighborRow{}
	walkLLDPColumn := func(columnOID string, apply func(*lldpNeighborRow, string)) {
		_ = walkColumn(client, columnOID, func(variable gosnmp.SnmpPDU) error {
			parts := oidSuffixParts(columnOID, variable.Name)
			if len(parts) != 3 {
				return nil
			}
			key := lldpNeighborKey{TimeMark: parts[0], LocalPortNum: parts[1], RemoteIndex: parts[2]}
			row := rows[key]
			if row == nil {
				row = &lldpNeighborRow{LocalPortNum: parts[1], Raw: map[string]string{}}
				rows[key] = row
			}
			value := snmpValueText(variable.Value)
			row.Raw[columnOID] = value
			apply(row, value)
			return nil
		})
	}

	walkLLDPColumn(".1.0.8802.1.1.2.1.4.1.1.5", func(row *lldpNeighborRow, value string) { row.RemoteChassis = value })
	walkLLDPColumn(".1.0.8802.1.1.2.1.4.1.1.7", func(row *lldpNeighborRow, value string) { row.RemotePortID = value })
	walkLLDPColumn(".1.0.8802.1.1.2.1.4.1.1.8", func(row *lldpNeighborRow, value string) { row.RemotePortDesc = value })
	walkLLDPColumn(".1.0.8802.1.1.2.1.4.1.1.9", func(row *lldpNeighborRow, value string) { row.RemoteSysName = value })
	walkLLDPColumn(".1.0.8802.1.1.2.1.4.1.1.10", func(row *lldpNeighborRow, value string) { row.RemoteSysDesc = value })

	neighbors := make([]NeighborInfo, 0, len(rows))
	for _, row := range rows {
		if row.RemoteChassis == "" && row.RemotePortID == "" && row.RemoteSysName == "" {
			continue
		}
		localPortID := localPortIDs[row.LocalPortNum]
		localPortDesc := localPortDescs[row.LocalPortNum]
		neighbors = append(neighbors, NeighborInfo{
			DeviceID:         device.ID,
			LocalPortID:      localPortID,
			LocalPortDescr:   localPortDesc,
			Protocol:         "lldp",
			RemoteChassisID:  row.RemoteChassis,
			RemoteDeviceName: firstNonEmpty(row.RemoteSysName, row.RemoteChassis),
			RemotePortID:     row.RemotePortID,
			RemotePortDescr:  row.RemotePortDesc,
			RemoteSysName:    row.RemoteSysName,
			RemoteSysDescr:   row.RemoteSysDesc,
			Raw:              row.Raw,
			LastSeenAt:       now,
		})
	}
	return neighbors
}

func collectCDPNeighbors(device Device, client *gosnmp.GoSNMP, now time.Time) []NeighborInfo {
	rows := map[cdpNeighborKey]*cdpNeighborRow{}
	walkCDPColumn := func(columnOID string, apply func(*cdpNeighborRow, string)) {
		_ = walkColumn(client, columnOID, func(variable gosnmp.SnmpPDU) error {
			parts := oidSuffixParts(columnOID, variable.Name)
			if len(parts) < 2 {
				return nil
			}
			key := cdpNeighborKey{IfIndex: parts[0], Index: parts[1]}
			row := rows[key]
			if row == nil {
				row = &cdpNeighborRow{IfIndex: parts[0], Raw: map[string]string{}}
				rows[key] = row
			}
			value := snmpValueText(variable.Value)
			row.Raw[columnOID] = value
			apply(row, value)
			return nil
		})
	}

	walkCDPColumn(".1.3.6.1.4.1.9.9.23.1.2.1.1.4", func(row *cdpNeighborRow, value string) { row.RemoteAddress = value })
	walkCDPColumn(".1.3.6.1.4.1.9.9.23.1.2.1.1.6", func(row *cdpNeighborRow, value string) { row.RemoteDeviceID = value })
	walkCDPColumn(".1.3.6.1.4.1.9.9.23.1.2.1.1.7", func(row *cdpNeighborRow, value string) { row.RemotePortID = value })
	walkCDPColumn(".1.3.6.1.4.1.9.9.23.1.2.1.1.8", func(row *cdpNeighborRow, value string) { row.RemotePlatform = value })
	walkCDPColumn(".1.3.6.1.4.1.9.9.23.1.2.1.1.9", func(row *cdpNeighborRow, value string) { row.RemoteCaps = value })

	neighbors := make([]NeighborInfo, 0, len(rows))
	for _, row := range rows {
		if row.RemoteDeviceID == "" && row.RemotePortID == "" {
			continue
		}
		ifIndex, _ := strconv.Atoi(row.IfIndex)
		neighbors = append(neighbors, NeighborInfo{
			DeviceID:          device.ID,
			LocalIfIndex:      ifIndex,
			Protocol:          "cdp",
			RemoteChassisID:   row.RemoteDeviceID,
			RemoteDeviceName:  row.RemoteDeviceID,
			RemotePortID:      row.RemotePortID,
			RemotePortDescr:   row.RemotePortID,
			RemoteMgmtAddress: normalizeIPv4Text(row.RemoteAddress),
			RemoteSysName:     row.RemoteDeviceID,
			RemoteSysDescr:    row.RemotePlatform,
			Raw:               row.Raw,
			LastSeenAt:        now,
		})
	}
	return neighbors
}

func walkTextColumn(client *gosnmp.GoSNMP, columnOID string) map[string]string {
	values := map[string]string{}
	_ = walkColumn(client, columnOID, func(variable gosnmp.SnmpPDU) error {
		parts := oidSuffixParts(columnOID, variable.Name)
		if len(parts) != 1 {
			return nil
		}
		values[parts[0]] = snmpValueText(variable.Value)
		return nil
	})
	return values
}

func walkColumn(client *gosnmp.GoSNMP, columnOID string, walkFn func(gosnmp.SnmpPDU) error) error {
	if err := client.BulkWalk(columnOID, walkFn); err != nil {
		return client.Walk(columnOID, walkFn)
	}
	return nil
}

func oidSuffixParts(baseOID string, variableOID string) []string {
	suffix := strings.TrimPrefix(oidKey(variableOID), oidKey(baseOID))
	suffix = strings.TrimPrefix(suffix, ".")
	if suffix == "" {
		return nil
	}
	return strings.Split(suffix, ".")
}

func normalizeIPv4Text(value string) string {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) < 4 {
		return ""
	}
	last := parts[len(parts)-4:]
	for _, part := range last {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 || number > 255 {
			return ""
		}
	}
	return strings.Join(last, ".")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
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

func snmpNumericValue(value interface{}) (float64, bool) {
	text := strings.TrimSpace(snmpValueText(value))
	if text == "" {
		return 0, false
	}
	number, err := strconv.ParseFloat(text, 64)
	return number, err == nil
}

func scaledSNMPValueText(metric MetricDefinition, value interface{}) string {
	number, ok := snmpNumericValue(value)
	if !ok {
		return snmpValueText(value)
	}
	return formatMetricFloat(metric, number*metricScale(metric))
}

func metricScale(metric MetricDefinition) float64 {
	if metric.Scale == 0 {
		return 1
	}
	return metric.Scale
}

func aggregateValues(values []float64, method string) float64 {
	if len(values) == 0 {
		return 0
	}

	switch strings.ToLower(strings.TrimSpace(method)) {
	case "avg", "average":
		var total float64
		for _, value := range values {
			total += value
		}
		return total / float64(len(values))
	case "sum":
		var total float64
		for _, value := range values {
			total += value
		}
		return total
	case "first":
		return values[0]
	case "latest", "last":
		return values[len(values)-1]
	default:
		maximum := values[0]
		for _, value := range values[1:] {
			if value > maximum {
				maximum = value
			}
		}
		return maximum
	}
}

func formatFloat(value float64) string {
	if value == float64(int64(value)) {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func formatMetricFloat(metric MetricDefinition, value float64) string {
	precision := metric.Precision
	if precision < 0 {
		precision = 2
	}
	if precision == 0 {
		return strconv.FormatInt(int64(math.Round(value)), 10)
	}
	if value == float64(int64(value)) {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', precision, 64)
}

func community(device Device, fallback string) string {
	if device.Community != "" {
		return device.Community
	}
	return fallback
}
