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

type NeighborInfo struct {
	DeviceID          int64
	LocalIfIndex      int
	LocalPortID       string
	LocalPortDescr    string
	Protocol          string
	RemoteChassisID   string
	RemoteDeviceName  string
	RemotePortID      string
	RemotePortDescr   string
	RemoteMgmtAddress string
	RemoteSysName     string
	RemoteSysDescr    string
	Raw               map[string]string
	LastSeenAt        time.Time
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
	ID          int64
	RuleID      int64
	DeviceID    int64
	InterfaceID int64
	Severity    string
	Title       string
	Message     string
	Value       string
	CreatedAt   time.Time
	ResolvedAt  time.Time
	Status      string
	DeviceName  string
}

type RetentionPolicy struct {
	MetricSamplesDays    int
	InterfaceSamplesDays int
	ResolvedAlertsDays   int
	BatchSize            int
}

func (policy RetentionPolicy) Enabled() bool {
	return policy.MetricSamplesDays > 0 || policy.InterfaceSamplesDays > 0 || policy.ResolvedAlertsDays > 0
}

type CleanupStats struct {
	MetricSamples    int64
	InterfaceSamples int64
	ResolvedAlerts   int64
}

type AlertNotification struct {
	ID         int64
	EventID    int64
	Channel    string
	Target     string
	Status     string
	Subject    string
	Message    string
	Error      string
	RetryCount int
	CreatedAt  time.Time
	SentAt     time.Time
}

type NotificationSettings struct {
	Enabled       bool
	Targets       []string
	SendResolved  bool
	SubjectPrefix string
}
