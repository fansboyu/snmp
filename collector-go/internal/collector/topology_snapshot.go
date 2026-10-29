package collector

import (
	"context"
	"encoding/hex"
	"fmt"
	"github.com/gosnmp/gosnmp"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type TopologyScan struct {
	Protocol, Status, Reason string
	CheckedAt                time.Time
	Count                    int
}
type TopologyIdentity struct{ Kind, Value string }
type TopologySnapshot struct {
	Neighbors  []NeighborInfo
	Scans      []TopologyScan
	Identities []TopologyIdentity
}
type TopologyStore interface {
	SaveTopologySnapshot(context.Context, int64, TopologySnapshot) error
}
type neighborScan struct{ errors []error }

func scanArgument(scans []*neighborScan) *neighborScan {
	if len(scans) > 0 {
		return scans[0]
	}
	return &neighborScan{}
}
func (scan *neighborScan) walk(client *gosnmp.GoSNMP, oid string, fn func(gosnmp.SnmpPDU) error) {
	if err := walkColumn(client, oid, fn); err != nil {
		scan.errors = append(scan.errors, fmt.Errorf("OID %s: %w", oid, err))
	}
}
func (scan *neighborScan) outcome(protocol string, count int) TopologyScan {
	status := "success"
	reason := "邻居快照完整"
	if count == 0 {
		status = "empty"
		reason = "完整查询成功，邻居为空"
	}
	if len(scan.errors) > 0 {
		status = "partial"
		if count == 0 {
			status = "failed"
		}
		reason = fmt.Sprintf("%d 列查询失败，保留原连接证据；%v", len(scan.errors), scan.errors[0])
		if len(reason) > 1000 {
			reason = string([]rune(reason)[:min(250, len([]rune(reason)))])
		}
	}
	return TopologyScan{Protocol: protocol, Status: status, Reason: reason, CheckedAt: time.Now().UTC(), Count: count}
}

func (engine Engine) collectTopologySnapshot(device Device, client *gosnmp.GoSNMP) TopologySnapshot {
	snapshot := TopologySnapshot{}
	if packet, err := client.Get([]string{".1.3.6.1.2.1.1.5.0"}); err == nil && packet != nil {
		for _, v := range packet.Variables {
			if v.Type != gosnmp.NoSuchObject && v.Type != gosnmp.NoSuchInstance {
				snapshot.Identities = append(snapshot.Identities, TopologyIdentity{Kind: "sysname", Value: snmpValueText(v.Value)})
			}
		}
	}
	for _, protocol := range []string{"lldp", "cdp"} {
		oid := ".1.0.8802.1.1.2.1.3.2.0"
		if protocol == "cdp" {
			oid = ".1.3.6.1.4.1.9.9.23.1.3.1.0"
		}
		packet, err := client.Get([]string{oid})
		if err != nil || packet == nil || len(packet.Variables) == 0 {
			reason := "协议探测未返回有效结果，保留原连接证据"
			if err != nil {
				reason = fmt.Sprintf("协议探测失败，保留原连接证据：%v", err)
			}
			snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: protocol, Status: "failed", Reason: reason, CheckedAt: time.Now().UTC()})
			continue
		}
		v := packet.Variables[0]
		if v.Type == gosnmp.NoSuchObject || v.Type == gosnmp.NoSuchInstance || v.Type == gosnmp.EndOfMibView {
			snapshot.Scans = append(snapshot.Scans, TopologyScan{Protocol: protocol, Status: "unsupported", Reason: "协议 OID 不支持或不可见", CheckedAt: time.Now().UTC()})
			continue
		}
		if protocol == "lldp" {
			snapshot.Identities = append(snapshot.Identities, TopologyIdentity{Kind: "chassis", Value: topologyChassisText(v.Value)})
		}
		scan := &neighborScan{}
		var neighbors []NeighborInfo
		if protocol == "lldp" {
			neighbors = collectLLDPNeighbors(device, client, time.Now().UTC(), scan)
		} else {
			neighbors = collectCDPNeighbors(device, client, time.Now().UTC(), scan)
		}
		snapshot.Neighbors = append(snapshot.Neighbors, neighbors...)
		snapshot.Scans = append(snapshot.Scans, scan.outcome(protocol, len(neighbors)))
	}
	return snapshot
}

func topologyChassisText(value interface{}) string {
	text := snmpValueText(value)
	bytes := []byte(text)
	if len(bytes) == 6 || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return hex.EncodeToString(bytes)
	}
	return strings.TrimSpace(text)
}

// LLDP management address table indices: timeMark,localPort,remoteIndex,
// addressSubtype,addressLength,address octets. IPv4 and IPv6 are supported.
func lldpManagementAddress(parts []string) string {
	if len(parts) < 5 {
		return ""
	}
	family, _ := strconv.Atoi(parts[3])
	length, _ := strconv.Atoi(parts[4])
	if (family != 1 || length != 4) && (family != 2 || length != 16) {
		return ""
	}
	if len(parts) != 5+length {
		return ""
	}
	bytes := make(net.IP, length)
	for i, part := range parts[5:] {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 || value > 255 {
			return ""
		}
		bytes[i] = byte(value)
	}
	return bytes.String()
}
