package collector

import (
	"errors"
	"reflect"
	"testing"
)

func TestTopologySnapshotOutcomes(t *testing.T) {
	scan := &neighborScan{}
	if scan.outcome("lldp", 0).Status != "empty" {
		t.Fatal("successful empty must be distinct")
	}
	if scan.outcome("lldp", 2).Status != "success" {
		t.Fatal("complete neighbors not recognized")
	}
	scan.errors = append(scan.errors, errors.New("timeout"))
	if scan.outcome("lldp", 1).Status != "partial" || scan.outcome("lldp", 0).Status != "failed" {
		t.Fatal("partial and failed snapshots must not expire old links")
	}
}
func TestLLDPManagementAddressIndices(t *testing.T) {
	if got := lldpManagementAddress([]string{"1", "2", "3", "1", "4", "192", "0", "2", "1"}); got != "192.0.2.1" {
		t.Fatal(got)
	}
	if got := lldpManagementAddress([]string{"1", "2", "3", "1", "4", "192", "0", "2", "300"}); got != "" {
		t.Fatal("invalid octet accepted")
	}
	if got := lldpManagementAddress([]string{"1", "2", "3", "1", "4", "192"}); got != "" {
		t.Fatal("incomplete address accepted")
	}
	if got := topologyChassisText([]byte{0, 1, 2, 255, 128, 6}); got != "000102ff8006" {
		t.Fatal("binary chassis identity is not safe text", got)
	}
	if !reflect.DeepEqual(scanArgument(nil).errors, []error(nil)) {
		t.Fatal("unexpected errors")
	}
}

func TestLLDPIdentifierTextPreservesSubtypeAndBinarySafety(t *testing.T) {
	if got := lldpIdentifierText([]byte{0xaa, 0xc1, 0xab, 0x1a, 0x83, 0x38}, 3); got != "aa:c1:ab:1a:83:38" {
		t.Fatalf("MAC subtype rendered incorrectly: %q", got)
	}
	if got := lldpIdentifierText([]byte("eth1"), 5); got != "eth1" {
		t.Fatalf("interface-name subtype rendered incorrectly: %q", got)
	}
	if got := lldpIdentifierText([]byte{1, 192, 0, 2, 10}, 4); got != "192.0.2.10" {
		t.Fatalf("IPv4 network-address subtype rendered incorrectly: %q", got)
	}
	if got := safeSNMPText([]byte{0xaa, 0xc1, 0xab}); got != "hex:aac1ab" {
		t.Fatalf("binary value was not represented safely: %q", got)
	}
	if got := safeSNMPText([]byte("端口一")); got != "端口一" {
		t.Fatalf("valid UTF-8 text was altered: %q", got)
	}
}
