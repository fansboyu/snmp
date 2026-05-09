package collector

import "time"

type Device struct {
	ID        int64
	Name      string
	Host      string
	Port      int
	Community string
}

type MetricDefinition struct {
	ID   int64
	Name string
	OID  string
	Unit string
}

type MetricSample struct {
	DeviceID  int64
	MetricID  int64
	Value     string
	CreatedAt time.Time
}

