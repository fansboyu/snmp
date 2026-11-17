package wecomconfig

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

type Config struct {
	Enabled         bool     `json:"enabled"`
	CorpID          string   `json:"corpId"`
	AgentID         int      `json:"agentId"`
	UserIDs         []string `json:"userIds"`
	SendResolved    bool     `json:"sendResolved"`
	EncryptedSecret string   `json:"encryptedSecret"`
}

func (config Config) Secret(secret string) (string, error) {
	if config.EncryptedSecret == "" {
		return "", nil
	}
	packed, err := base64.StdEncoding.DecodeString(config.EncryptedSecret)
	if err != nil {
		return "", fmt.Errorf("invalid encrypted WeCom application secret")
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
		return "", fmt.Errorf("invalid encrypted WeCom application secret")
	}
	value, err := gcm.Open(nil, packed[:gcm.NonceSize()], packed[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("cannot decrypt WeCom application secret: verify shared JWT_SECRET")
	}
	return string(value), nil
}
