package collector

import (
	"context"
	"github.com/gosnmp/gosnmp"
	"net"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestPingFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		code     int
		output   string
		expected bool
	}{
		{1, "100% packet loss", true}, {2, "network setup failed", false},
		{1, "Operation not permitted", false}, {1, "Permission denied", false},
	} {
		cmd := exec.Command(os.Args[0], "-test.run=TestHealthExitHelper")
		cmd.Env = append(os.Environ(), "HEALTH_TEST_EXIT="+strconv.Itoa(tc.code))
		err := cmd.Run()
		if got := pingFailedConclusively(err, tc.output); got != tc.expected {
			t.Fatalf("exit=%d output=%q: got %t", tc.code, tc.output, got)
		}
	}
	if pingFailedConclusively(context.Canceled, "") {
		t.Fatal("canceled probe counted as offline")
	}
	if pingFailedConclusively(exec.ErrNotFound, "") {
		t.Fatal("missing ping counted as offline")
	}
}

func TestHealthExitHelper(t *testing.T) {
	if value := os.Getenv("HEALTH_TEST_EXIT"); value != "" {
		code, _ := strconv.Atoi(value)
		os.Exit(code)
	}
}

func TestHealthSNMPResponse(t *testing.T) {
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	go func() {
		buffer := make([]byte, 4096)
		n, peer, err := socket.ReadFrom(buffer)
		if err != nil {
			return
		}
		decoder := &gosnmp.GoSNMP{Version: gosnmp.Version2c}
		request, err := decoder.SnmpDecodePacket(buffer[:n])
		if err != nil {
			return
		}
		request.PDUType = gosnmp.GetResponse
		request.Variables = []gosnmp.SnmpPDU{{Name: ".1.3.6.1.2.1.1.2.0", Type: gosnmp.ObjectIdentifier, Value: ".1.3.6.1.4.1.8072"}}
		response, err := request.MarshalMsg()
		if err == nil {
			socket.WriteTo(response, peer)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := (&Engine{DefaultCommunity: "public"}).probeHealth(ctx, Device{Host: "127.0.0.1", Port: socket.LocalAddr().(*net.UDPAddr).Port, SNMPVersion: "2c"})
	if !result.SNMPOK || result.PingOK || !result.Conclusive {
		t.Fatalf("unexpected response: %+v", result)
	}
}

func TestHealthNetworkFallback(t *testing.T) {
	if os.Getenv("RUN_NETWORK_HEALTH_TESTS") != "1" {
		t.Skip("run in collector Docker image with RUN_NETWORK_HEALTH_TESTS=1")
	}
	// A UDP socket that drops SNMP requests models a device with SNMP blocked.
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	engine := &Engine{DefaultCommunity: "public"}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := engine.probeHealth(ctx, Device{Host: "127.0.0.1", Port: socket.LocalAddr().(*net.UDPAddr).Port, SNMPVersion: "2c"})
	if result.SNMPOK || !result.PingOK || !result.Conclusive {
		t.Fatalf("Ping fallback failed: %+v", result)
	}
	canceled, stop := context.WithCancel(context.Background())
	stop()
	result = engine.probeHealth(canceled, Device{Host: "127.0.0.1", Port: 161, SNMPVersion: "2c"})
	if result.Conclusive {
		t.Fatal("canceled network probe treated as offline evidence")
	}
}
