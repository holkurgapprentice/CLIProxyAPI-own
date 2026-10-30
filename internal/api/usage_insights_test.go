package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api/handlers/management"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/usageinsights"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func TestUsageInsightsManagementAndAssets(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "test-password")
	cfg := &config.Config{}
	h := management.NewHandler(cfg, filepath.Join(t.TempDir(), "config.yaml"), nil)
	h.SetLocalPassword("test-password")
	store, err := usageinsights.NewStore(filepath.Join(t.TempDir(), "events.jsonl"), nil)
	if err != nil {
		t.Fatal(err)
	}
	store.HandleUsage(context.Background(), coreusage.Record{RequestID: "request-one", Model: "routed", Alias: "favorite", ResponseModel: "served", Provider: "codex", Detail: coreusage.Detail{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 80, TotalTokens: 120}})
	h.SetUsageInsights(store)
	s := &Server{cfg: cfg, engine: gin.New(), mgmt: h}
	s.managementRoutesEnabled.Store(true)
	s.registerManagementV8Routes()
	s.engine.GET("/usage-insights/*asset", s.serveUsageInsights)
	for _, tc := range []struct {
		path       string
		authorized bool
		want       int
	}{
		{"/v8/management/observability/usage/insights", false, 401},
		{"/v8/management/observability/usage/insights", true, 200},
		{"/v8/management/observability/usage/insights?from=invalid", true, 400},
		{"/v8/management/observability/usage/insights?export=1&provider=claude", true, 200},
		{"/usage-insights/", false, 200}, {"/usage-insights/app.js", false, 200}, {"/usage-insights/bridge.js", false, 200}, {"/usage-insights/store.go", false, 404},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		req.RemoteAddr = "127.0.0.1:1000"
		if tc.authorized {
			req.Header.Set("Authorization", "Bearer test-password")
		}
		res := httptest.NewRecorder()
		s.engine.ServeHTTP(res, req)
		if res.Code != tc.want {
			t.Fatalf("%s: %d %s", tc.path, res.Code, res.Body.String())
		}
		if tc.authorized && tc.path == "/v8/management/observability/usage/insights" {
			var snap usageinsights.Snapshot
			if err := json.Unmarshal(res.Body.Bytes(), &snap); err != nil {
				t.Fatal(err)
			}
			if snap.Totals.Total != 120 || snap.Groups[0].Reported != "served" {
				t.Fatal("incorrect API output")
			}
		}
		if strings.Contains(tc.path, "export=1") && res.Body.String() != "[]" {
			t.Fatal("filtered export includes other provider")
		}
	}
	cfg.RemoteManagement.DisableControlPanel = true
	res := httptest.NewRecorder()
	s.engine.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/usage-insights/", nil))
	if res.Code != 404 {
		t.Fatal("ignored disabled panel")
	}
}
