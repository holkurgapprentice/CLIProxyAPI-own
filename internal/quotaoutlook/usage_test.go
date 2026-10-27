package quotaoutlook

import (
	"context"
	"math"
	"testing"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func TestClaudePlan(t *testing.T) {
	for body, want := range map[string]string{
		`{"organization":{"rate_limit_tier":"default_claude_max_20x"},"account":{"has_claude_max":true}}`: "max_20x",
		`{"organization":{"organization_type":"claude_team"}}`:                                            "team",
		`{"account":{"has_claude_max":true,"has_claude_pro":false}}`:                                      "max",
		`{"account":{"has_claude_max":false,"has_claude_pro":true}}`:                                      "pro",
		`{"account":{"has_claude_max":false,"has_claude_pro":false}}`:                                     "free",
		`{}`:       "",
		`not json`: "",
	} {
		if got := ClaudePlan([]byte(body)); got != want {
			t.Errorf("ClaudePlan(%s) = %q, want %q", body, got, want)
		}
	}
}

func TestWeightedTokensFollowsPriceRatios(t *testing.T) {
	breakdown := coreusage.TokenBreakdown{
		Input:  coreusage.TokenInputBreakdown{UncachedTokens: 100, CacheReadTokens: 1000, CacheWriteTokens: 40},
		Output: coreusage.TokenOutputBreakdown{TotalTokens: 10},
	}
	if got := WeightedTokens("claude", "claude-sonnet-4-5", breakdown); got != 100+100+50+50 {
		t.Fatalf("sonnet units = %v", got)
	}
	if got := WeightedTokens("claude", "claude-opus-4-5", breakdown); math.Abs(got-500) > 1e-9 {
		t.Fatalf("opus units = %v", got)
	}
	if got := WeightedTokens("codex", "gpt-5-codex", breakdown); got != 100+100+50+80 {
		t.Fatalf("codex units = %v", got)
	}
}

func TestMeterAnnotatesSamplesPerCredential(t *testing.T) {
	meter := &usageMeter{epoch: "e1", units: map[string]float64{}}
	detail := coreusage.Detail{InputTokens: 100, OutputTokens: 10, TotalTokens: 110}
	meter.HandleUsage(context.Background(), coreusage.Record{AuthIndex: "a", Provider: "claude", Model: "claude-sonnet-4-5", Detail: detail})
	meter.HandleUsage(context.Background(), coreusage.Record{AuthIndex: "a", Provider: "claude", Failed: true, Detail: detail})
	meter.HandleUsage(context.Background(), coreusage.Record{Provider: "claude", Detail: detail})
	RememberPlan("a", "team")
	samples := meter.Annotate([]Sample{{Account: "a"}, {Account: "b"}})
	if samples[0].Usage != 150 || samples[0].Epoch != "e1" || samples[0].Plan != "team" || samples[1].Usage != 0 || samples[1].Plan != "" {
		t.Fatalf("annotated = %+v", samples)
	}
}
