package collector

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

const (
	qBridgeVlanFDBOID = ".1.3.6.1.2.1.17.7.1.4.2.1.3"
	qBridgeFDBPortOID = ".1.3.6.1.2.1.17.7.1.2.2.1.2"
	bridgeFDBPortOID  = ".1.3.6.1.2.1.17.4.3.1.2"
	bridgePortIfOID   = ".1.3.6.1.2.1.17.1.4.1.2"
	ipNetMediaPhysOID = ".1.3.6.1.2.1.4.22.1.2"
	ifNameOID         = ".1.3.6.1.2.1.31.1.1.1.1"
	ifDescrOID        = ".1.3.6.1.2.1.2.2.1.2"
)

type MACPortObservation struct {
	DeviceID   int64
	VLAN       *int
	MAC        string
	IfIndex    int
	ObservedAt time.Time
}

type IPMACObservation struct {
	DeviceID   int64
	VLAN       *int
	IfIndex    int
	IP         string
	MAC        string
	ObservedAt time.Time
}

type EndpointSnapshot struct {
	MACPorts []MACPortObservation
	IPMACs   []IPMACObservation
	Scans    []TopologyScan
}

// collectEndpointSnapshot combines standard bridge FDB and IPv4 ARP MIBs.
// It records raw observations only; cross-device correlation is done by API so
// the source and freshness of each side remain visible.
func collectEndpointSnapshot(device Device, client *gosnmp.GoSNMP, now time.Time) EndpointSnapshot {
	snapshot := EndpointSnapshot{}
	bridgePorts := map[int]int{}
	bridgeErr := walkColumn(client, bridgePortIfOID, func(v gosnmp.SnmpPDU) error {
		idx, ok := singleIndex(bridgePortIfOID, v.Name)
		if !ok {
			return nil
		}
		ifIndex, valid := numericIndex(v.Value)
		if valid && ifIndex > 0 {
			bridgePorts[idx] = ifIndex
		}
		return nil
	})

	vlanFDBs := map[int][]int{}
	qVLANErr := walkColumn(client, qBridgeVlanFDBOID, func(v gosnmp.SnmpPDU) error {
		addQBridgeVLANFDB(vlanFDBs, v)
		return nil
	})

	var qRows []MACPortObservation
	qFDBErr := walkColumn(client, qBridgeFDBPortOID, func(v gosnmp.SnmpPDU) error {
		parts := oidSuffixParts(qBridgeFDBPortOID, v.Name)
		if len(parts) != 7 {
			return nil
		}
		fdb, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil
		}
		bridgePort, ok := numericIndex(v.Value)
		if !ok || bridgePort <= 0 {
			return nil
		}
		ifIndex := bridgePorts[bridgePort]
		if ifIndex <= 0 {
			return nil
		}
		mac := macFromOID(parts[1:])
		if mac == "" || isSpecialMAC(mac) {
			return nil
		}
		vlans := vlanFDBs[fdb]
		if len(vlans) == 0 {
			qRows = append(qRows, MACPortObservation{DeviceID: device.ID, MAC: mac, IfIndex: ifIndex, ObservedAt: now})
			return nil
		}
		for _, vlan := range vlans {
			vlanCopy := vlan
			qRows = append(qRows, MACPortObservation{DeviceID: device.ID, VLAN: &vlanCopy, MAC: mac, IfIndex: ifIndex, ObservedAt: now})
		}
		return nil
	})
	if qFDBErr == nil && qVLANErr == nil && bridgeErr == nil && len(qRows) > 0 {
		snapshot.MACPorts = qRows
		snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "qbridge_fdb", Status: "success", Reason: "已读取 VLAN/FDB/MAC/端口关联", CheckedAt: now, Count: len(qRows)})
	} else if qFDBErr == nil && qVLANErr == nil && bridgeErr == nil {
		snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "qbridge_fdb", Status: "empty", Reason: "Q-BRIDGE 表可读但当前未发现 MAC 端口记录", CheckedAt: now})
	} else {
		reason := firstError(qFDBErr, qVLANErr, bridgeErr)
		snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "qbridge_fdb", Status: "failed", Reason: "Q-BRIDGE 查询失败：" + reason, CheckedAt: now})
	}

	// BRIDGE-MIB fallback works for single-FDB switches; VLAN remains unknown.
	if len(snapshot.MACPorts) == 0 {
		var rows []MACPortObservation
		err := walkColumn(client, bridgeFDBPortOID, func(v gosnmp.SnmpPDU) error {
			parts := oidSuffixParts(bridgeFDBPortOID, v.Name)
			if len(parts) != 6 {
				return nil
			}
			bridgePort, ok := numericIndex(v.Value)
			if !ok || bridgePort <= 0 {
				return nil
			}
			ifIndex := bridgePorts[bridgePort]
			mac := macFromOID(parts)
			if ifIndex > 0 && mac != "" && !isSpecialMAC(mac) {
				rows = append(rows, MACPortObservation{DeviceID: device.ID, MAC: mac, IfIndex: ifIndex, ObservedAt: now})
			}
			return nil
		})
		if err == nil {
			snapshot.MACPorts = rows
			status, reason := "success", "已读取 BRIDGE-MIB MAC 端口表；设备未提供可关联 VLAN 的 Q-BRIDGE 表"
			if len(rows) == 0 {
				status, reason = "empty", "BRIDGE-MIB 表可读但当前未发现 MAC 端口记录"
			}
			snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "bridge_fdb", Status: status, Reason: reason, CheckedAt: now, Count: len(rows)})
		} else {
			snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "bridge_fdb", Status: "unsupported", Reason: "Q-BRIDGE 与 BRIDGE FDB 均不可读：" + err.Error(), CheckedAt: now})
		}
	}

	ifNames := map[int]string{}
	for _, oid := range []string{ifNameOID, ifDescrOID} {
		_ = walkColumn(client, oid, func(v gosnmp.SnmpPDU) error {
			idx, ok := singleIndex(oid, v.Name)
			if ok && ifNames[idx] == "" {
				ifNames[idx] = snmpValueText(v.Value)
			}
			return nil
		})
	}
	var arpRows []IPMACObservation
	arperr := walkColumn(client, ipNetMediaPhysOID, func(v gosnmp.SnmpPDU) error {
		parts := oidSuffixParts(ipNetMediaPhysOID, v.Name)
		if len(parts) != 5 {
			return nil
		}
		ifIndex, e := strconv.Atoi(parts[0])
		if e != nil || ifIndex <= 0 {
			return nil
		}
		ip := ipv4FromOID(parts[1:])
		mac := macFromBytes(v.Value)
		if ip == "" || mac == "" || isSpecialMAC(mac) {
			return nil
		}
		arpRows = append(arpRows, IPMACObservation{DeviceID: device.ID, VLAN: inferVLAN(ifNames[ifIndex]), IfIndex: ifIndex, IP: ip, MAC: mac, ObservedAt: now})
		return nil
	})
	if arperr == nil {
		status, reason := "success", "已读取 IPv4 ARP 表；SVI 名称可识别时附带 VLAN"
		if len(arpRows) == 0 {
			status, reason = "empty", "ARP 表可读但当前没有 IPv4 邻居记录"
		}
		snapshot.IPMACs = arpRows
		snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "arp", Status: status, Reason: reason, CheckedAt: now, Count: len(arpRows)})
	} else {
		snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: "arp", Status: "unsupported", Reason: "标准 IPv4 ARP 表不可读：" + arperr.Error(), CheckedAt: now})
	}
	return snapshot
}

var vlanInterfacePattern = regexp.MustCompile(`(?i)(?:vlan(?:if|[-_ ]?interface)?|vlan)[- _]*(\d+)`)

func addQBridgeVLANFDB(vlanFDBs map[int][]int, variable gosnmp.SnmpPDU) {
	// dot1qVlanFdbId is indexed by dot1qVlanIndex only; its value is the FDB ID.
	parts := oidSuffixParts(qBridgeVlanFDBOID, variable.Name)
	if len(parts) != 1 {
		return
	}
	vlan, err := strconv.Atoi(parts[0])
	fdb, ok := numericIndex(variable.Value)
	if err != nil || vlan < 1 || vlan > 4094 || !ok || fdb < 1 {
		return
	}
	for _, existing := range vlanFDBs[fdb] {
		if existing == vlan {
			return
		}
	}
	vlanFDBs[fdb] = append(vlanFDBs[fdb], vlan)
}

func inferVLAN(name string) *int {
	match := vlanInterfacePattern.FindStringSubmatch(strings.TrimSpace(name))
	if len(match) != 2 {
		return nil
	}
	vlan, err := strconv.Atoi(match[1])
	if err != nil || vlan < 1 || vlan > 4094 {
		return nil
	}
	return &vlan
}
func firstError(errors ...error) string {
	for _, err := range errors {
		if err != nil {
			return err.Error()
		}
	}
	return "未知错误"
}
func numericIndex(value interface{}) (int, bool) {
	n := gosnmp.ToBigInt(value)
	if n == nil || !n.IsInt64() {
		return 0, false
	}
	return int(n.Int64()), true
}
func singleIndex(base, oid string) (int, bool) {
	p := oidSuffixParts(base, oid)
	if len(p) != 1 {
		return 0, false
	}
	n, e := strconv.Atoi(p[0])
	return n, e == nil
}
func macFromOID(parts []string) string {
	b := make([]byte, len(parts))
	if len(parts) != 6 {
		return ""
	}
	for i, p := range parts {
		n, e := strconv.Atoi(p)
		if e != nil || n < 0 || n > 255 {
			return ""
		}
		b[i] = byte(n)
	}
	return net.HardwareAddr(b).String()
}
func macFromBytes(value interface{}) string {
	b, ok := value.([]byte)
	if !ok || len(b) != 6 {
		return ""
	}
	return net.HardwareAddr(b).String()
}
func ipv4FromOID(parts []string) string {
	if len(parts) != 4 {
		return ""
	}
	b := make(net.IP, 4)
	for i, p := range parts {
		n, e := strconv.Atoi(p)
		if e != nil || n < 0 || n > 255 {
			return ""
		}
		b[i] = byte(n)
	}
	return b.String()
}
func isSpecialMAC(mac string) bool {
	b, e := net.ParseMAC(mac)
	return e != nil || len(b) != 6 || b[0]&1 != 0
}
func validateEndpoint(o MACPortObservation) error {
	if o.IfIndex < 1 || o.MAC == "" {
		return fmt.Errorf("invalid MAC port observation")
	}
	return nil
}
