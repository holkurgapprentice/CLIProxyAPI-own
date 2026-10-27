package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotaoutlook"
)

// quotaCollectorInterval is how often the server records quota for the outlook history.
const quotaCollectorInterval = time.Hour

type quotaCollector struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (q *quotaCollector) stop() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.cancel != nil {
		q.cancel()
		q.cancel = nil
	}
}

// quotaOutlookEnabled mirrors when the outlook page is served.
func (s *Server) quotaOutlookEnabled() bool {
	cfg := s.getConfig()
	return cfg != nil && !cfg.Home.Enabled && !cfg.RemoteManagement.DisableControlPanel && s.managementRoutesEnabled.Load()
}

// startQuotaCollector records quota hourly while the server runs, independent of open browser tabs.
func (s *Server) startQuotaCollector() {
	if s.mgmt == nil {
		return
	}
	s.quotaCollector.mu.Lock()
	defer s.quotaCollector.mu.Unlock()
	if s.quotaCollector.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.quotaCollector.cancel = cancel
	s.mgmt.StartQuotaCollector(ctx, quotaCollectorInterval, s.quotaOutlookEnabled)
}

func (s *Server) serveQuotaOutlook(c *gin.Context) {
	if cfg := s.getConfig(); cfg == nil || cfg.Home.Enabled || cfg.RemoteManagement.DisableControlPanel {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	name := c.Param("asset")
	mime := "text/javascript; charset=utf-8"
	switch name {
	case "/", "":
		name = "index.html"
		mime = "text/html; charset=utf-8"
	case "/app.js":
		name = "app.js"
	case "/math.js":
		name = "math.js"
	case "/management.js":
		name = "management.js"
	default:
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	data, errRead := quotaoutlook.Assets.ReadFile(name)
	if errRead != nil {
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mime, data)
}
