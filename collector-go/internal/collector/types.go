package collector

import "time"

type Device struct {
	ID                   int64
	Name                 string
	Host                 string
	Port                 int
	Community            string
	SNMPVersion          string
	SNMPV3Username       string
	SNMPV3SecurityLevel  string
	SNMPV3AuthProtocol   string
	SNMPV3AuthPassphrase string
	SNMPV3PrivProtocol   string
	SNMPV3PrivPassphrase string
	SNMPV3ContextName    string
	TemplateID           int64
}

type MetricDefinition struct {
	ID         int64
	Name       string
	OID        string
	Unit       string
	MetricKind string
	TableOID   string
}

type MetricSample struct {
	DeviceID   int64
	MetricID   int64
	MetricName string
	Value      string
	CreatedAt  time.Time
}

type InterfaceInfo struct {
	DeviceID   int64
	IfIndex    int
	IfDescr    string
	IfName     string
	IfAlias    string
	OperStatus string
	LastSeenAt time.Time
}

type InterfaceMetricSample struct {
	DeviceID    int64
	InterfaceID int64
	MetricID    int64
	MetricName  string
	IfIndex     int
	Value       string
	CreatedAt   time.Time
}

type AlertRule struct {
	ID          int64
	Name        string
	RuleType    string
	Severity    string
	DeviceID    int64
	InterfaceID int64
	MetricName  string
	Operator    string
	Threshold   float64
	Enabled     bool
}

type AlertEvent struct {
	RuleID      int64
	DeviceID    int64
	InterfaceID int64
	Severity    string
	Title       string
	Message     string
	Value       string
	CreatedAt   time.Time
}
