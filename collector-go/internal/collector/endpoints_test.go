package collector

import (
	"reflect"
	"testing"

	"github.com/gosnmp/gosnmp"
)

func TestQBridgeVLANFDBUsesVLANIndexAndFDBValue(t *testing.T) {
	const base = ".1.3.6.1.2.1.17.7.1.4.2.1.3"
	got := map[int][]int{}
	addQBridgeVLANFDB(got, gosnmp.SnmpPDU{
		Name:  base + ".120",
		Type:  gosnmp.Integer,
		Value: int(4096),
	})
	if want := []int{120}; !reflect.DeepEqual(got[4096], want) {
		t.Fatalf("FDB-to-VLAN mapping = %v, want %v", got[4096], want)
	}
}

func TestQBridgeVLANFDBRejectsInvalidRowsAndDeduplicates(t *testing.T) {
	const base = ".1.3.6.1.2.1.17.7.1.4.2.1.3"
	got := map[int][]int{}
	valid := gosnmp.SnmpPDU{Name: base + ".30", Type: gosnmp.Integer, Value: 77}
	addQBridgeVLANFDB(got, valid)
	addQBridgeVLANFDB(got, valid)
	addQBridgeVLANFDB(got, gosnmp.SnmpPDU{Name: base + ".0", Value: 78})
	addQBridgeVLANFDB(got, gosnmp.SnmpPDU{Name: base + ".4095", Value: 79})
	addQBridgeVLANFDB(got, gosnmp.SnmpPDU{Name: base + ".10.20", Value: 80})
	if want := []int{30}; !reflect.DeepEqual(got[77], want) {
		t.Fatalf("valid VLAN mapping = %v, want %v", got[77], want)
	}
	if len(got) != 1 {
		t.Fatalf("invalid VLAN rows were accepted: %#v", got)
	}
}

func TestInferVLANFromSVIName(t *testing.T) {
	for _, name := range []string{"Vlan-interface120", "Vlanif120", "Vlan 120"} {
		vlan := inferVLAN(name)
		if vlan == nil || *vlan != 120 {
			t.Errorf("inferVLAN(%q) = %v, want 120", name, vlan)
		}
	}
	if vlan := inferVLAN("GigabitEthernet1/0/1"); vlan != nil {
		t.Fatalf("inferred a VLAN from a non-SVI name: %d", *vlan)
	}
}

func TestEndpointObservationRetentionKeepsMaintenanceEnabled(t *testing.T) {
	if !(RetentionPolicy{EndpointObservationsDays: 90}).Enabled() {
		t.Fatal("endpoint observation cleanup must run when it is the only enabled retention policy")
	}
}
