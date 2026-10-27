package quotaoutlook

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/tidwall/gjson"
)

// Meter counts price-weighted tokens routed through each credential since the server started.
// Pairing these counters with quota percentage drops measures how large each subscription is.
var Meter = &usageMeter{epoch: strconv.FormatInt(time.Now().UnixNano(), 36), units: map[string]float64{}}

func init() { coreusage.RegisterPlugin(Meter) }

type usageMeter struct {
	mu    sync.Mutex
	epoch string
	units map[string]float64
}

// HandleUsage implements the usage plugin interface.
func (m *usageMeter) HandleUsage(_ context.Context, record coreusage.Record) {
	if record.Failed || strings.TrimSpace(record.AuthIndex) == "" {
		return
	}
	units := WeightedTokens(record.Provider, record.Model, coreusage.EnsureTokenBreakdownForProvider(record.Detail, record.Provider, record.ExecutorType).TokenBreakdown)
	if units <= 0 {
		return
	}
	m.mu.Lock()
	m.units[record.AuthIndex] += units
	m.mu.Unlock()
}

// Annotate stamps samples with the cumulative usage counter and plan of their credential.
// Counters restart with the server, so the epoch tells clients which samples are comparable.
func (m *usageMeter) Annotate(samples []Sample) []Sample {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range samples {
		samples[i].Usage = m.units[samples[i].Account]
		samples[i].Epoch = m.epoch
		if plan, ok := plans.Load(samples[i].Account); ok {
			samples[i].Plan = plan.(string)
		}
	}
	return samples
}

// WeightedTokens approximates subscription cost in uncached-input-token equivalents,
// following list price ratios between token kinds and model families.
func WeightedTokens(provider, model string, b coreusage.TokenBreakdown) float64 {
	output := 5.0
	if provider == "codex" {
		output = 8
	}
	units := float64(b.Input.UncachedTokens) + 0.1*float64(b.Input.CacheReadTokens) + 1.25*float64(b.Input.CacheWriteTokens) +
		output*float64(b.Output.TotalTokens) + float64(b.UnclassifiedTokens)
	model = strings.ToLower(model)
	switch {
	case strings.Contains(model, "opus"):
		units *= 5.0 / 3
	case strings.Contains(model, "haiku"):
		units /= 3
	case strings.Contains(model, "mini"):
		units /= 5
	}
	return units
}

var plans sync.Map

// RememberPlan records a credential's subscription plan for later samples.
func RememberPlan(account, plan string) {
	if account != "" && plan != "" && len(plan) <= 32 {
		plans.Store(account, plan)
	}
}

// KnownPlan reports whether a plan was already recorded for the credential.
func KnownPlan(account string) bool {
	_, ok := plans.Load(account)
	return ok
}

// ClaudePlan reads the subscription plan from a Claude OAuth profile response.
func ClaudePlan(body []byte) string {
	if !gjson.ValidBytes(body) {
		return ""
	}
	profile := gjson.ParseBytes(body)
	tier := strings.ToLower(profile.Get("organization.rate_limit_tier").String())
	switch {
	case strings.Contains(tier, "max_20x"):
		return "max_20x"
	case strings.Contains(tier, "max_5x"):
		return "max_5x"
	}
	switch strings.ToLower(profile.Get("organization.organization_type").String()) {
	case "claude_team":
		return "team"
	case "claude_enterprise":
		return "enterprise"
	}
	maxPlan, proPlan := profile.Get("account.has_claude_max"), profile.Get("account.has_claude_pro")
	switch {
	case maxPlan.Bool():
		return "max"
	case proPlan.Bool():
		return "pro"
	case maxPlan.Exists() && proPlan.Exists():
		return "free"
	}
	return ""
}
