package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotaoutlook"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestQuotaRecordingStoresConsoleUsageWithoutCredentials(t *testing.T) {
	manager := coreauth.NewManager(nil, nil, nil)
	auth := &coreauth.Auth{ID: "quota-account", Provider: "claude", Metadata: map[string]any{"access_token": "must-not-be-written"}}
	index := auth.EnsureIndex()
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	h := NewHandler(&config.Config{}, configPath, manager)
	usage := `{"seven_day":{"utilization":26,"resets_at":"2026-11-01T00:00:00Z"},"five_hour":{"utilization":1}}`
	response, _ := json.Marshal(apiCallResponse{StatusCode: http.StatusOK, Body: usage})
	request := func(url string) string {
		body, _ := json.Marshal(map[string]any{"auth_index": index, "method": "GET", "url": url, "header": map[string]string{"Authorization": "Bearer $TOKEN$"}})
		return string(body)
	}

	// The middleware must pass request and response bodies through unchanged.
	engine := gin.New()
	engine.POST("/v8/management/requests/api-call", h.RecordQuotaObservations(), func(c *gin.Context) {
		var got map[string]any
		if err := c.ShouldBindJSON(&got); err != nil || got["auth_index"] != index {
			t.Errorf("handler did not receive the original body: %v %v", got, err)
		}
		c.Data(http.StatusOK, "application/json", response)
	})
	recorder := httptest.NewRecorder()
	// A non-quota URL keeps the asynchronous recorder out of this check.
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v8/management/requests/api-call", strings.NewReader(request("https://example.com/ping"))))
	if recorder.Code != http.StatusOK || recorder.Body.String() != string(response) {
		t.Fatalf("response changed: %d %s", recorder.Code, recorder.Body.String())
	}

	h.recordQuotaResponse(true, []byte(request("https://example.com/api/oauth/usage")), response)
	h.recordQuotaResponse(true, []byte(request(codexUsageURL)), response)
	if samples, _ := h.quotaHistoryStore().Read(time.Now()); len(samples) != 0 {
		t.Fatalf("recorded unrelated or mismatched requests: %+v", samples)
	}
	h.recordQuotaResponse(true, []byte(request(claudeUsageURL+"?skip_spend=1")), response)
	samples, err := h.quotaHistoryStore().Read(time.Now())
	if err != nil || len(samples) != 2 || samples[0].Account != index || samples[0].Limit != "seven_day" || samples[0].Remaining != 74 {
		t.Fatalf("history = %+v, %v", samples, err)
	}
	data, err := os.ReadFile(quotaoutlook.HistoryPath(configPath))
	if err != nil || strings.Contains(string(data), "must-not-be-written") || strings.Contains(string(data), "Bearer") {
		t.Fatalf("stored credential material: %v", err)
	}
}

func TestCollectQuotaSkipsUnsupportedCredentials(t *testing.T) {
	manager := coreauth.NewManager(nil, nil, nil)
	for _, auth := range []*coreauth.Auth{
		{ID: "claude-key", Provider: "claude", Attributes: map[string]string{"api_key": "sk-test"}},
		{ID: "gemini-key", Provider: "gemini", Attributes: map[string]string{"api_key": "test"}},
		{ID: "disabled", Provider: "claude", Disabled: true},
	} {
		if _, err := manager.Register(context.Background(), auth); err != nil {
			t.Fatal(err)
		}
	}
	h := NewHandler(&config.Config{}, filepath.Join(t.TempDir(), "config.yaml"), manager)
	collected, failed := h.CollectQuota(context.Background())
	if collected != 0 || len(failed) != 0 {
		t.Fatalf("collected=%d failed=%v", collected, failed)
	}
}

func TestQuotaUsageProviderRecognizesKimiDomains(t *testing.T) {
	for raw, want := range map[string]string{
		"https://api.kimi.com/coding/v1/usages":      "kimi",
		"https://api.kimi.ai/coding/v1/usages/":      "kimi",
		"https://api.kimi.com/coding/v1/models":      "",
		"https://chatgpt.com/backend-api/wham/usage": "codex",
	} {
		if got := quotaUsageProvider(raw); got != want {
			t.Errorf("quotaUsageProvider(%q) = %q, want %q", raw, got, want)
		}
	}
	if got := quotaProvider(&coreauth.Auth{Provider: "kimi-ai"}); got != "kimi" {
		t.Fatalf("kimi-ai provider = %q", got)
	}
}
