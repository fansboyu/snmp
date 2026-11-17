package notifier

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const weComAPI = "https://qyapi.weixin.qq.com/cgi-bin"

type WeComClient struct {
	mu           sync.Mutex
	client       *http.Client
	corpID       string
	secret       string
	credentialID string
	token        string
	tokenExpires time.Time
}

func NewWeComClient(previous *WeComClient, corpID, secret string, timeout time.Duration) *WeComClient {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	hash := sha256.Sum256([]byte(corpID + "\x00" + secret))
	credentialID := hex.EncodeToString(hash[:])
	if previous != nil && previous.credentialID == credentialID {
		return previous
	}
	return &WeComClient{
		client:       &http.Client{Timeout: timeout},
		corpID:       corpID,
		secret:       secret,
		credentialID: credentialID,
	}
}

func (client *WeComClient) Send(ctx context.Context, agentID int, userIDs, content string) error {
	userIDs = strings.Trim(userIDs, "|")
	if userIDs == "" {
		return fmt.Errorf("WeCom notification has no recipient UserID")
	}
	if len([]rune(content)) > 1800 {
		return fmt.Errorf("WeCom notification content exceeds 1800 characters")
	}
	for attempt := 0; attempt < 2; attempt++ {
		token, err := client.accessToken(ctx)
		if err != nil {
			return err
		}
		payload := struct {
			ToUser  string `json:"touser"`
			MsgType string `json:"msgtype"`
			AgentID int    `json:"agentid"`
			Text    struct {
				Content string `json:"content"`
			} `json:"text"`
		}{ToUser: userIDs, MsgType: "text", AgentID: agentID}
		payload.Text.Content = content
		response, err := client.postJSON(ctx, weComAPI+"/message/send?access_token="+url.QueryEscape(token), payload)
		if err != nil {
			return err
		}
		if response.ErrCode == 42001 || response.ErrCode == 40014 {
			client.clearToken()
			continue
		}
		if response.ErrCode != 0 {
			return fmt.Errorf("WeCom message API error %d: %s", response.ErrCode, response.ErrMsg)
		}
		return nil
	}
	return fmt.Errorf("WeCom rejected the access token after refresh")
}

func (client *WeComClient) accessToken(ctx context.Context) (string, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.token != "" && time.Now().Before(client.tokenExpires) {
		return client.token, nil
	}
	query := url.Values{}
	query.Set("corpid", client.corpID)
	query.Set("corpsecret", client.secret)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, weComAPI+"/gettoken?"+query.Encode(), nil)
	if err != nil {
		return "", fmt.Errorf("build WeCom token request")
	}
	response, err := client.client.Do(request)
	if err != nil {
		// net/http errors include the request URL, which contains the app secret.
		return "", fmt.Errorf("connect to WeCom token API failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("WeCom token API returned HTTP %d", response.StatusCode)
	}
	var result struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		ErrCode     int    `json:"errcode"`
		ErrMsg      string `json:"errmsg"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return "", fmt.Errorf("decode WeCom token response")
	}
	if result.ErrCode != 0 || result.AccessToken == "" {
		return "", fmt.Errorf("WeCom token API error %d: %s", result.ErrCode, result.ErrMsg)
	}
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 7200
	}
	client.token = result.AccessToken
	client.tokenExpires = time.Now().Add(time.Duration(result.ExpiresIn) * time.Second).Add(-5 * time.Minute)
	return client.token, nil
}

func (client *WeComClient) clearToken() {
	client.mu.Lock()
	client.token = ""
	client.tokenExpires = time.Time{}
	client.mu.Unlock()
}

type weComAPIResponse struct {
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

func (client *WeComClient) postJSON(ctx context.Context, endpoint string, payload any) (weComAPIResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return weComAPIResponse{}, fmt.Errorf("encode WeCom message")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return weComAPIResponse{}, fmt.Errorf("build WeCom message request")
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response, err := client.client.Do(request)
	if err != nil {
		return weComAPIResponse{}, fmt.Errorf("connect to WeCom message API failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return weComAPIResponse{}, fmt.Errorf("WeCom message API returned HTTP %d", response.StatusCode)
	}
	var result weComAPIResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return weComAPIResponse{}, fmt.Errorf("decode WeCom message response")
	}
	return result, nil
}
