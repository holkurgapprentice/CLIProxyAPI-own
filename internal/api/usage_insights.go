package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/usageinsights"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
)

func (s *Server) initializeUsageInsights(configPath string) {
	store, err := usageinsights.NewStore(filepath.Join(filepath.Dir(configPath), "usage-insights.jsonl"), func() bool {
		cfg := s.getConfig()
		return cfg != nil && cfg.UsageStatisticsEnabled
	})
	if err != nil {
		log.WithError(err).Error("usage insights history unavailable")
		return
	}
	s.mgmt.SetUsageInsights(store)
	coreusage.RegisterNamedPlugin("usage-insights", store)
}

func (s *Server) serveUsageInsights(c *gin.Context) {
	cfg := s.getConfig()
	if cfg == nil || cfg.Home.Enabled || cfg.RemoteManagement.DisableControlPanel {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	name := strings.TrimPrefix(c.Param("asset"), "/")
	mime := "text/javascript; charset=utf-8"
	if name == "" {
		name = "index.html"
		mime = "text/html; charset=utf-8"
	}
	if name != "index.html" && name != "app.js" && name != "bridge.js" && name != "icons.js" {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	data, err := usageinsights.Assets.ReadFile(name)
	if err != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	c.Data(http.StatusOK, mime, data)
}
