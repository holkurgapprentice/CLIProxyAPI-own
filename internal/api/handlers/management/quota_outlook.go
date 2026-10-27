package management

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotaoutlook"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const (
	claudeUsageURL   = "https://api.anthropic.com/api/oauth/usage"
	claudeProfileURL = "https://api.anthropic.com/api/oauth/profile"
	codexUsageURL    = "https://chatgpt.com/backend-api/wham/usage"
	// quotaCollectDelay lets credentials load before the first scheduled check.
	quotaCollectDelay = time.Minute
	maxRecordedBody   = 4 << 20
)

func (h *Handler) quotaHistoryStore() *quotaoutlook.Store {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.quotaHistory == nil {
		h.quotaHistory = quotaoutlook.NewStore(quotaoutlook.HistoryPath(h.configFilePath))
	}
	return h.quotaHistory
}

// QuotaHistory returns bounded percentage observations, never upstream responses or tokens.
func (h *Handler) QuotaHistory(c *gin.Context) {
	samples, errRead := h.quotaHistoryStore().Read(time.Now())
	if errRead != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "quota history unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"samples": samples})
}

// CollectQuotaHistory checks every enabled credential now and returns the updated history.
func (h *Handler) CollectQuotaHistory(c *gin.Context) {
	collected, failed := h.CollectQuota(c.Request.Context())
	samples, errRead := h.quotaHistoryStore().Read(time.Now())
	if errRead != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "quota history unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"samples": samples, "collected": collected, "failed": failed})
}

// StartQuotaCollector checks quotas shortly after start and then every interval until ctx ends.
func (h *Handler) StartQuotaCollector(ctx context.Context, interval time.Duration, enabled func() bool) {
	go func() {
		timer := time.NewTimer(quotaCollectDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			if enabled == nil || enabled() {
				collected, failed := h.CollectQuota(ctx)
				log.WithFields(log.Fields{"limits": collected, "failed": len(failed)}).Debug("quota outlook: scheduled quota check finished")
			}
			timer.Reset(interval)
		}
	}()
}

// CollectQuota polls enabled credentials sequentially to avoid bursting upstream quota endpoints.
// It returns the number of stored limits and the auth indexes whose quota could not be read.
func (h *Handler) CollectQuota(ctx context.Context) (int, []string) {
	failed := []string{}
	if h == nil || h.authManager == nil {
		return 0, failed
	}
	h.quotaCollectMu.Lock()
	defer h.quotaCollectMu.Unlock()
	var batch []quotaoutlook.Sample
	for _, auth := range h.authManager.List() {
		if ctx.Err() != nil {
			break
		}
		if auth == nil || auth.Disabled {
			continue
		}
		index := auth.EnsureIndex()
		samples, supported := h.fetchQuotaSamples(ctx, auth)
		if !supported {
			continue
		}
		if len(samples) == 0 {
			failed = append(failed, index)
			continue
		}
		batch = append(batch, samples...)
	}
	if len(batch) == 0 {
		return 0, failed
	}
	if _, errSave := h.quotaHistoryStore().Append(quotaoutlook.Meter.Annotate(batch), time.Now()); errSave != nil {
		log.WithError(errSave).Warn("quota outlook: failed to save quota history")
		return 0, failed
	}
	return len(batch), failed
}

// fetchQuotaSamples reuses the management handlers so token refresh and proxy selection stay identical.
func (h *Handler) fetchQuotaSamples(ctx context.Context, auth *coreauth.Auth) ([]quotaoutlook.Sample, bool) {
	provider := strings.TrimSpace(auth.Provider)
	if provider == "claude" || provider == "codex" {
		// API key credentials have no subscription quota endpoint.
		if auth.Attributes != nil && strings.TrimSpace(auth.Attributes["api_key"]) != "" {
			return nil, false
		}
		request := apiCallRequest{AuthIndexSnake: &auth.Index, Method: http.MethodGet, URL: claudeUsageURL,
			Header: map[string]string{"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20"}}
		if provider == "codex" {
			request.URL = codexUsageURL
			request.Header = map[string]string{"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json"}
			if account, ok := extractCodexIDTokenClaims(auth)["chatgpt_account_id"].(string); ok {
				request.Header["Chatgpt-Account-Id"] = account
			}
		}
		status, body := invokeManagement(ctx, h.APICall, request)
		if status != http.StatusOK {
			return nil, true
		}
		h.rememberQuotaPlan(ctx, auth, request.Header)
		return apiCallQuotaSamples(auth, body), true
	}
	status, body := invokeManagement(ctx, h.FetchCredentialQuota, map[string]string{"auth_index": auth.Index})
	if status == http.StatusNotImplemented || status == http.StatusNotFound {
		return nil, false
	}
	if status != http.StatusOK {
		return nil, true
	}
	return quotaoutlook.Normalize(auth.Index, provider, body, time.Now()), true
}

// rememberQuotaPlan records the subscription plan used as a size estimate before usage is measured.
func (h *Handler) rememberQuotaPlan(ctx context.Context, auth *coreauth.Auth, header map[string]string) {
	if auth.Provider == "codex" {
		if plan, ok := extractCodexIDTokenClaims(auth)["plan_type"].(string); ok {
			quotaoutlook.RememberPlan(auth.Index, strings.ToLower(plan))
		}
		return
	}
	if quotaoutlook.KnownPlan(auth.Index) {
		return
	}
	request := apiCallRequest{AuthIndexSnake: &auth.Index, Method: http.MethodGet, URL: claudeProfileURL, Header: header}
	if status, body := invokeManagement(ctx, h.APICall, request); status == http.StatusOK {
		var response apiCallResponse
		if errJSON := json.Unmarshal(body, &response); errJSON == nil && response.StatusCode == http.StatusOK {
			quotaoutlook.RememberPlan(auth.Index, quotaoutlook.ClaudePlan([]byte(response.Body)))
		}
	}
}

func apiCallQuotaSamples(auth *coreauth.Auth, body []byte) []quotaoutlook.Sample {
	var response apiCallResponse
	if errJSON := json.Unmarshal(body, &response); errJSON != nil || response.StatusCode != http.StatusOK {
		return nil
	}
	return quotaoutlook.Normalize(auth.Index, auth.Provider, []byte(response.Body), time.Now())
}

func invokeManagement(ctx context.Context, handler gin.HandlerFunc, payload any) (int, []byte) {
	data, errJSON := json.Marshal(payload)
	if errJSON != nil {
		return http.StatusInternalServerError, nil
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	request, errRequest := http.NewRequestWithContext(ctx, http.MethodPost, "/", bytes.NewReader(data))
	if errRequest != nil {
		return http.StatusInternalServerError, nil
	}
	request.Header.Set("Content-Type", "application/json")
	c.Request = request
	handler(c)
	return recorder.Code, recorder.Body.Bytes()
}

type recordingWriter struct {
	gin.ResponseWriter
	body bytes.Buffer
}

func (w *recordingWriter) Write(data []byte) (int, error) {
	if w.body.Len()+len(data) <= maxRecordedBody {
		w.body.Write(data)
	}
	return w.ResponseWriter.Write(data)
}

func (w *recordingWriter) WriteString(data string) (int, error) {
	if w.body.Len()+len(data) <= maxRecordedBody {
		w.body.WriteString(data)
	}
	return w.ResponseWriter.WriteString(data)
}

// RecordQuotaObservations stores quota percentages from successful console quota requests,
// so manual refreshes in the console also build quota history.
func (h *Handler) RecordQuotaObservations() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil {
			c.Next()
			return
		}
		requestBody, errRead := io.ReadAll(c.Request.Body)
		c.Request.Body = io.NopCloser(bytes.NewReader(requestBody))
		if errRead != nil {
			c.Next()
			return
		}
		writer := &recordingWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		c.Next()
		if writer.Status() != http.StatusOK {
			return
		}
		responseBody := writer.body.Bytes()
		apiCall := strings.HasSuffix(c.FullPath(), "/api-call")
		// Persist after the response is sent; the store rewrites a file.
		go h.recordQuotaResponse(apiCall, requestBody, responseBody)
	}
}

func (h *Handler) recordQuotaResponse(apiCall bool, requestBody, responseBody []byte) {
	var request struct {
		AuthIndex string `json:"auth_index"`
		AuthCamel string `json:"authIndex"`
		Method    string `json:"method"`
		URL       string `json:"url"`
	}
	if errJSON := json.Unmarshal(requestBody, &request); errJSON != nil {
		return
	}
	if request.AuthIndex == "" {
		request.AuthIndex = request.AuthCamel
	}
	auth := h.authByIndex(request.AuthIndex)
	if auth == nil {
		return
	}
	var samples []quotaoutlook.Sample
	if apiCall {
		if !strings.EqualFold(request.Method, http.MethodGet) {
			return
		}
		if auth.Provider == "claude" && isClaudeProfileURL(request.URL) {
			var response apiCallResponse
			if errJSON := json.Unmarshal(responseBody, &response); errJSON == nil && response.StatusCode == http.StatusOK {
				quotaoutlook.RememberPlan(auth.Index, quotaoutlook.ClaudePlan([]byte(response.Body)))
			}
			return
		}
		if quotaUsageProvider(request.URL) != auth.Provider {
			return
		}
		if auth.Provider == "codex" {
			h.rememberQuotaPlan(context.Background(), auth, nil)
		}
		samples = apiCallQuotaSamples(auth, responseBody)
	} else if auth.Provider != "claude" && auth.Provider != "codex" {
		samples = quotaoutlook.Normalize(auth.Index, auth.Provider, responseBody, time.Now())
	}
	if len(samples) == 0 {
		return
	}
	if _, errSave := h.quotaHistoryStore().Append(quotaoutlook.Meter.Annotate(samples), time.Now()); errSave != nil {
		log.WithError(errSave).Warn("quota outlook: failed to record quota observation")
	}
}

func isClaudeProfileURL(raw string) bool {
	parsed, errParse := url.Parse(strings.TrimSpace(raw))
	return errParse == nil && strings.EqualFold(parsed.Hostname(), "api.anthropic.com") && strings.TrimSuffix(parsed.Path, "/") == "/api/oauth/profile"
}

// quotaUsageProvider identifies the subscription usage endpoints the console and collector query.
func quotaUsageProvider(raw string) string {
	parsed, errParse := url.Parse(strings.TrimSpace(raw))
	if errParse != nil {
		return ""
	}
	host, path := strings.ToLower(parsed.Hostname()), strings.TrimSuffix(parsed.Path, "/")
	switch {
	case host == "api.anthropic.com" && path == "/api/oauth/usage":
		return "claude"
	case host == "chatgpt.com" && path == "/backend-api/wham/usage":
		return "codex"
	}
	return ""
}
