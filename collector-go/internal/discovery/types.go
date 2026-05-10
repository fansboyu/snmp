package discovery

type Job struct {
	ID              int64
	CIDR            string
	Port            int
	SNMPVersion     string
	Community       string
	TimeoutMS       int
	Retries         int
	Concurrency     int
	TotalHosts      int
	ScannedHosts    int
	DiscoveredHosts int
	Status          string
}

type Result struct {
	JobID       int64
	Host        string
	Port        int
	SNMPVersion string
	SysName     string
	SysDescr    string
	SysObjectID string
	ResponseMS  int
	Status      string
	Error       string
}
