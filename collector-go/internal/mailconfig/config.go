package mailconfig

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

type Config struct {
	EmailEnabled      bool     `json:"emailEnabled"`
	EmailTo           []string `json:"emailTo"`
	SendResolved      bool     `json:"sendResolved"`
	SubjectPrefix     string   `json:"subjectPrefix"`
	SMTPHost          string   `json:"smtpHost"`
	SMTPPort          int      `json:"smtpPort"`
	SMTPFrom          string   `json:"smtpFrom"`
	SMTPUsername      string   `json:"smtpUsername"`
	EncryptedPassword string   `json:"encryptedPassword"`
	SMTPTLSMode       string   `json:"smtpTlsMode"`
}

func (config Config) Password(secret string) (string, error) {
	if config.EncryptedPassword == "" {
		return "", nil
	}
	packed, err := base64.StdEncoding.DecodeString(config.EncryptedPassword)
	if err != nil {
		return "", fmt.Errorf("invalid encrypted SMTP password")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(packed) < gcm.NonceSize()+gcm.Overhead() {
		return "", fmt.Errorf("invalid encrypted SMTP password")
	}
	password, err := gcm.Open(nil, packed[:gcm.NonceSize()], packed[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("cannot decrypt SMTP password: verify shared JWT_SECRET")
	}
	return string(password), nil
}
