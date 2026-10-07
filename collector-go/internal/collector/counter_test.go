package collector

import "testing"

func TestCounterPreservesUint64(t *testing.T) {
	v := uint64(18000000000000000100)
	if got := scaledSNMPValueText(MetricDefinition{ValueType: "counter", Scale: 1}, v); got != "18000000000000000100" {
		t.Fatalf("counter lost precision: %s", got)
	}
	if got := scaledSNMPValueText(MetricDefinition{ValueType: "string", Scale: 1}, []byte("001 uplink")); got != "001 uplink" {
		t.Fatalf("alias changed: %s", got)
	}
}
