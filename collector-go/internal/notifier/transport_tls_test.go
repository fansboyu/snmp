//go:build !windows

package notifier

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the actual transport against a loopback SMTP fixture. No mail leaves
// the test process; Linux SSL_CERT_FILE lets us trust a temporary test CA.
func TestSMTPTransportTLS(t *testing.T) {
	certificate, root := smtpCertificate(t)
	file := filepath.Join(t.TempDir(), "root.pem")
	if err := os.WriteFile(file, root, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", file)
	t.Setenv("SSL_CERT_DIR", t.TempDir())
	for _, mode := range []string{"starttls", "implicit", "missing-starttls", "untrusted"} {
		t.Run(mode, func(t *testing.T) {
			cert := certificate
			if mode == "untrusted" {
				cert, _ = smtpCertificate(t)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if mode == "implicit" {
				listener = tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
			}
			messages := make(chan string, 1)
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				reader := bufio.NewReader(conn)
				fmt.Fprint(conn, "220 localhost ESMTP\r\n")
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					switch {
					case strings.HasPrefix(line, "EHLO"):
						if mode == "missing-starttls" {
							fmt.Fprint(conn, "250 localhost\r\n")
						} else {
							fmt.Fprint(conn, "250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n")
						}
					case strings.HasPrefix(line, "STARTTLS"):
						fmt.Fprint(conn, "220 ready\r\n")
						secure := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
						if secure.Handshake() != nil {
							return
						}
						conn = secure
						reader = bufio.NewReader(conn)
					case strings.HasPrefix(line, "AUTH"):
						if _, ok := conn.(*tls.Conn); !ok {
							return
						}
						fmt.Fprint(conn, "235 authenticated\r\n")
					case strings.HasPrefix(line, "DATA"):
						fmt.Fprint(conn, "354 send\r\n")
						var body strings.Builder
						for {
							line, err = reader.ReadString('\n')
							if err != nil {
								return
							}
							if line == ".\r\n" {
								break
							}
							body.WriteString(line)
						}
						messages <- body.String()
						fmt.Fprint(conn, "250 accepted locally\r\n")
					case strings.HasPrefix(line, "QUIT"):
						fmt.Fprint(conn, "221 bye\r\n")
						return
					default:
						fmt.Fprint(conn, "250 ok\r\n")
					}
				}
			}()
			auth := smtp.PlainAuth("", "fixture", "fixture", "127.0.0.1")
			message := []byte("Subject: local TLS regression\r\n\r\nlocal-only\r\n")
			if mode == "implicit" {
				err = sendImplicitTLS(listener.Addr().String(), "127.0.0.1", 3*time.Second, auth, "test@example.invalid", []string{"test@example.invalid"}, message)
			} else {
				err = sendStartTLS(listener.Addr().String(), "127.0.0.1", 3*time.Second, auth, "test@example.invalid", []string{"test@example.invalid"}, message)
			}
			if mode == "missing-starttls" || mode == "untrusted" {
				if err == nil {
					t.Fatal("Unsafe TLS configuration accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				select {
				case body := <-messages:
					if !strings.Contains(body, "local-only") {
						t.Fatal("Body missing")
					}
				case <-time.After(time.Second):
					t.Fatal("No local delivery")
				}
			}
			listener.Close()
			select {
			case <-done:
			case <-time.After(6 * time.Second):
				t.Fatal("SMTP fixture did not stop")
			}
		})
	}
}

func smtpCertificate(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: serial, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private}, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
