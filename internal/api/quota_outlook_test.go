package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api/handlers/management"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

func TestQuotaOutlookAssetsAndManagementIntegration(t *testing.T) {
	static := t.TempDir()
	t.Setenv("MANAGEMENT_STATIC_PATH", static)
	original := `<html><head><script>consoleBundle()</script></head><body>upstream UI</body></html>`
	if err := os.WriteFile(filepath.Join(static, "management.html"), []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: &config.Config{}, configFilePath: filepath.Join(t.TempDir(), "config.yaml"), engine: gin.New()}
	s.engine.GET("/quota-outlook/*asset", s.serveQuotaOutlook)
	s.engine.GET("/management.html", s.serveManagementControlPanel)
	for _, path := range []string{"/quota-outlook/", "/quota-outlook/math.js", "/quota-outlook/app.js", "/quota-outlook/management.js", "/management.html"} {
		response := httptest.NewRecorder()
		s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d", path, response.Code)
		}
		if path == "/management.html" {
			body := response.Body.String()
			if !strings.Contains(body, `<head><script src="/quota-outlook/management.js"></script><script>consoleBundle()`) || strings.Contains(body, "position:fixed") {
				t.Fatal("management bridge must precede console bundle without a floating link")
			}
		}
	}
	onDisk, err := os.ReadFile(filepath.Join(static, "management.html"))
	if err != nil || string(onDisk) != original {
		t.Fatal("must not modify the downloaded management asset")
	}
	response := httptest.NewRecorder()
	s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/quota-outlook/store.go", nil))
	if response.Code != http.StatusNotFound {
		t.Fatal("exposed non-asset")
	}
	s.cfg.RemoteManagement.DisableControlPanel = true
	response = httptest.NewRecorder()
	s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/quota-outlook/", nil))
	if response.Code != http.StatusNotFound {
		t.Fatal("ignored disabled control panel")
	}
}

func TestQuotaOutlookManagementAccess(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "test-password")
	for _, path := range []string{"/v8/management/quota/history", "/v8/management/quota/providers"} {
		for _, authorized := range []bool{true, false} {
			cfg := &config.Config{}
			h := management.NewHandler(cfg, filepath.Join(t.TempDir(), "config.yaml"), nil)
			h.SetLocalPassword("test-password")
			s := &Server{cfg: cfg, engine: gin.New(), mgmt: h}
			s.managementRoutesEnabled.Store(true)
			s.registerManagementV8Routes()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.RemoteAddr = "127.0.0.1:1234"
			if authorized {
				req.Header.Set("Authorization", "Bearer test-password")
			}
			response := httptest.NewRecorder()
			s.engine.ServeHTTP(response, req)
			want := http.StatusUnauthorized
			if authorized {
				want = http.StatusOK
			}
			if response.Code != want {
				t.Fatalf("%s authorized=%v: got %d want %d", path, authorized, response.Code, want)
			}
		}
	}
}
