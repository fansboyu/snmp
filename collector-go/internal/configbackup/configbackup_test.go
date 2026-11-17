package configbackup

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestEncryptDecryptAndKeyValidation(t *testing.T) {
	encoded, err := Encrypt([]byte("hostname edge-1\n"), "test-only-key")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := Decrypt(encoded, "test-only-key")
	if err != nil || string(plain) != "hostname edge-1\n" {
		t.Fatalf("decrypt = %q, %v", plain, err)
	}
	if _, err := Decrypt(encoded, "wrong-key"); err == nil {
		t.Fatal("wrong encryption key unexpectedly decrypted backup")
	}
}

func TestCLICommandsAndReservedNetconf(t *testing.T) {
	for platform, expected := range map[string]string{
		"cisco_ios":   "show running-config",
		"huawei_vrp":  "display current-configuration",
		"h3c_comware": "display current-configuration",
	} {
		_, command, err := CLICommands(platform)
		if err != nil || command != expected {
			t.Fatalf("%s command = %q, %v", platform, command, err)
		}
	}
	adapter, err := AdapterFor("netconf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.Backup(context.Background(), Target{}); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("NETCONF should remain explicitly reserved, got %v", err)
	}
}

func TestSSHBackupUsesPinnedKeyAndDisablesPaging(t *testing.T) {
	listener, signer, stop := startFakeCLI(t)
	defer stop()
	port := listener.Addr().(*net.TCPAddr).Port
	fingerprint := ssh.FingerprintSHA256(signer.PublicKey())
	target := Target{
		Host: "127.0.0.1", Port: port, Username: "backup", Fingerprint: fingerprint,
		Platform: "huawei_vrp", Credential: Credential{Password: "test-only-password"},
	}
	content, err := (SSHAdapter{}).Backup(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(content); !strings.Contains(got, "sysname edge-1") || !strings.Contains(got, "password cipher test-value") {
		t.Fatalf("unexpected captured configuration: %q", got)
	}
	if strings.Contains(string(content), "screen-length") || strings.Contains(string(content), "<edge-1>") {
		t.Fatalf("CLI command/prompt leaked into backup: %q", content)
	}
	target.Fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, err := (SSHAdapter{}).Backup(context.Background(), target); err == nil || !strings.Contains(err.Error(), "pinned host key") {
		t.Fatalf("mismatched host key should be rejected, got %v", err)
	}
}

func startFakeCLI(t *testing.T) (net.Listener, ssh.Signer, func()) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	server := &ssh.ServerConfig{PasswordCallback: func(metadata ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if metadata.User() != "backup" || string(password) != "test-only-password" {
			return nil, fmt.Errorf("invalid test credentials")
		}
		return nil, nil
	}}
	server.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveFakeSSH(ctx, conn, server)
		}
	}()
	stop := func() { cancel(); _ = listener.Close() }
	return listener, signer, stop
}

func serveFakeSSH(ctx context.Context, conn net.Conn, config *ssh.ServerConfig) {
	defer conn.Close()
	serverConn, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	defer serverConn.Close()
	go ssh.DiscardRequests(requests)
	for {
		select {
		case <-ctx.Done():
			return
		case incoming, ok := <-channels:
			if !ok {
				return
			}
			if incoming.ChannelType() != "session" {
				_ = incoming.Reject(ssh.UnknownChannelType, "unsupported")
				continue
			}
			channel, reqs, err := incoming.Accept()
			if err != nil {
				continue
			}
			go fakeSession(channel, reqs)
		}
	}
}

func fakeSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	shellStarted := make(chan struct{})
	go func() {
		for request := range requests {
			switch request.Type {
			case "pty-req":
				_ = request.Reply(true, nil)
			case "shell":
				_ = request.Reply(true, nil)
				close(shellStarted)
			}
		}
	}()
	select {
	case <-shellStarted:
	case <-time.After(5 * time.Second):
		return
	}
	_, _ = channel.Write([]byte("<edge-1>"))
	reader := bufio.NewReader(channel)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.TrimSpace(line)
		if command == "display current-configuration" {
			_, _ = channel.Write([]byte("sysname edge-1\r\nlocal-user backup password cipher test-value\r\n<edge-1>"))
		} else {
			_, _ = channel.Write([]byte("<edge-1>"))
		}
	}
}
