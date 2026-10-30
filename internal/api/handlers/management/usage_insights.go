package management

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/usageinsights"
)

func (h *Handler) SetUsageInsights(store *usageinsights.Store) { h.usageInsights = store }

// UsageInsights provides non-consuming history and a credential-free JSON export.
func (h *Handler) UsageInsights(c *gin.Context) {
	if h.usageInsights == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "usage history unavailable"})
		return
	}
	f := usageinsights.Filter{Provider: c.Query("provider"), Model: c.Query("model"), Account: c.Query("account")}
	for name, target := range map[string]*time.Time{"from": &f.From, "to": &f.To} {
		if value := c.Query(name); value != "" {
			parsed, err := time.Parse(time.RFC3339, value)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": name + " must be RFC3339"})
				return
			}
			*target = parsed
		}
	}
	if !f.From.IsZero() && !f.To.IsZero() && !f.From.Before(f.To) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from must precede to"})
		return
	}
	c.Header("Cache-Control", "no-store")
	if c.Query("export") == "1" {
		c.Header("Content-Disposition", `attachment; filename="usage-insights.json"`)
		c.JSON(http.StatusOK, h.usageInsights.Events(f))
		return
	}
	c.JSON(http.StatusOK, h.usageInsights.Snapshot(f))
}
