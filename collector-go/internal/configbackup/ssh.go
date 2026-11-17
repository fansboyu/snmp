package configbackup

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const maxConfigBytes = 5 << 20

type Credential struct {
	Password             string `json:"password"`
	PrivateKey           string `json:"privateKey"`
	PrivateKeyPassphrase string `json:"privateKeyPassphrase"`
}

type Target struct {
	Host        string
	Port        int
	Username    string
	Fingerprint string
	Platform    string
	Credential  Credential
}

type Adapter interface {
	Backup(context.Context, Target) ([]byte, error)
}

type SSHAdapter struct{}

type NetconfAdapter struct{}

func AdapterFor(protocol string) (Adapter, error) {
	switch protocol {
	case "ssh":
		return SSHAdapter{}, nil
	case "netconf":
		return NetconfAdapter{}, nil
	default:
		return nil, errors.New("unsupported configuration backup protocol")
	}
}

func (NetconfAdapter) Backup(context.Context, Target) ([]byte, error) {
	return nil, errors.New("NETCONF is reserved for a future adapter; SSH is the only active protocol")
}

func CLICommands(platform string) (string, string, error) {
	switch platform {
	case "cisco_ios":
		return "terminal length 0", "show running-config", nil
	case "huawei_vrp":
		return "screen-length 0 temporary", "display current-configuration", nil
	case "h3c_comware":
		return "screen-length disable", "display current-configuration", nil
	default:
		return "", "", errors.New("unsupported SSH platform")
	}
}

var promptRE = regexp.MustCompile(`(?:^|\r?\n)(?:<[^<>\r\n]{1,128}>|[^\r\n]{1,128}[>#\]])\s*$`)
var ansiRE = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func (SSHAdapter) Backup(parent context.Context, target Target) ([]byte, error) {
	pagerCommand, backupCommand, err := CLICommands(target.Platform)
	if err != nil {
		return nil, err
	}
	if target.Fingerprint == "" {
		return nil, errors.New("SSH host key fingerprint is required")
	}
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()

	methods := make([]ssh.AuthMethod, 0, 2)
	if target.Credential.Password != "" {
		methods = append(methods, ssh.Password(target.Credential.Password))
	}
	if target.Credential.PrivateKey != "" {
		var signer ssh.Signer
		if target.Credential.PrivateKeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(target.Credential.PrivateKey), []byte(target.Credential.PrivateKeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(target.Credential.PrivateKey))
		}
		if err != nil {
			return nil, errors.New("SSH private key is invalid or its passphrase is incorrect")
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, errors.New("SSH password or private key is required")
	}
	if target.Port < 1 || target.Port > 65535 {
		return nil, errors.New("SSH port is invalid")
	}
	address := net.JoinHostPort(target.Host, fmt.Sprint(target.Port))
	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("SSH connection failed; check device reachability and port")
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	config := &ssh.ClientConfig{
		User: target.Username,
		Auth: methods,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			actual := ssh.FingerprintSHA256(key)
			if subtle.ConstantTimeCompare([]byte(actual), []byte(target.Fingerprint)) != 1 {
				return errors.New("SSH host key fingerprint mismatch")
			}
			return nil
		},
		Timeout: 10 * time.Second,
	}
	clientConn, channels, requests, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		return nil, errors.New("SSH authentication or pinned host key verification failed")
	}
	client := ssh.NewClient(clientConn, channels, requests)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return nil, errors.New("cannot open SSH CLI session")
	}
	defer session.Close()
	stdout, err := session.StdoutPipe()
	if err != nil {
		return nil, errors.New("cannot read SSH CLI output")
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return nil, errors.New("cannot read SSH CLI errors")
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return nil, errors.New("cannot write to SSH CLI")
	}
	if err := session.RequestPty("xterm", 50, 240, ssh.TerminalModes{ssh.ECHO: 1}); err != nil {
		return nil, errors.New("device does not support an interactive SSH terminal")
	}
	if err := session.Shell(); err != nil {
		return nil, errors.New("device did not open an SSH CLI")
	}
	go io.Copy(io.Discard, stderr)
	chunks := make(chan []byte, 32)
	readerErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				chunk := append([]byte(nil), buf[:n]...)
				select {
				case chunks <- chunk:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				readerErr <- err
				return
			}
		}
	}()
	buffer := make([]byte, 0, 32*1024)
	readPrompt := func() error {
		for {
			if promptRE.Match(ansiRE.ReplaceAll(buffer, nil)) {
				return nil
			}
			select {
			case <-ctx.Done():
				return errors.New("SSH CLI response timed out waiting for a prompt")
			case err := <-readerErr:
				if err != nil {
					return errors.New("SSH CLI session closed before returning a prompt")
				}
			case chunk := <-chunks:
				buffer = append(buffer, chunk...)
				if len(buffer) > maxConfigBytes {
					return errors.New("configuration output exceeds the 5 MiB safety limit")
				}
			}
		}
	}
	if err := readPrompt(); err != nil {
		return nil, err
	}
	buffer = buffer[:0]
	if _, err := io.WriteString(stdin, pagerCommand+"\n"); err != nil {
		return nil, errors.New("cannot disable device CLI paging")
	}
	if err := readPrompt(); err != nil {
		return nil, err
	}
	buffer = buffer[:0]
	if _, err := io.WriteString(stdin, backupCommand+"\n"); err != nil {
		return nil, errors.New("cannot request running configuration")
	}
	if err := readPrompt(); err != nil {
		return nil, err
	}
	content := cleanCLIOutput(buffer, backupCommand)
	if len(content) == 0 {
		return nil, errors.New("device returned an empty configuration")
	}
	if len(content) > maxConfigBytes {
		return nil, errors.New("configuration output exceeds the 5 MiB safety limit")
	}
	return content, nil
}

func cleanCLIOutput(raw []byte, command string) []byte {
	text := strings.ReplaceAll(string(ansiRE.ReplaceAll(raw, nil)), "\r", "")
	text = strings.ReplaceAll(text, "\x00", "")
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && strings.Contains(lines[0], command) {
		lines = lines[1:]
	}
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > 0 && promptRE.MatchString("\n"+lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	for i := range lines {
		line := strings.TrimSpace(lines[i])
		if strings.Contains(line, "---- More ----") || strings.Contains(line, "Press any key") {
			lines[i] = ""
		}
	}
	return bytes.TrimSpace([]byte(strings.Join(lines, "\n")))
}
