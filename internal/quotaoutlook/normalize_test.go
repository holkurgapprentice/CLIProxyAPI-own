package quotaoutlook

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNormalizeClaudeKeepsPercentagesOnly(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	body := `{"seven_day":{"utilization":25,"resets_at":"2026-10-26T13:00:00Z"},"five_hour":null,"seven_day_opus":{"utilization":-5},"extra_usage":{"used_credits":123},"access_token":"never-store"}`
	samples := Normalize("a", "claude", []byte(body), now)
	if len(samples) != 1 || samples[0].Limit != "seven_day" || samples[0].Remaining != 75 || samples[0].WindowHours != 168 || !samples[0].Reset.Equal(now.Add(time.Hour)) {
		t.Fatalf("unexpected samples: %+v", samples)
	}
	data, _ := json.Marshal(samples)
	if strings.Contains(string(data), "never-store") {
		t.Fatal("credential material leaked into samples")
	}
}

func TestNormalizeCodexWindowsAndModelLimits(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	body := `{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":1,"reset_at":1793000000,"limit_window_seconds":604800}},
		"additional_rate_limits":[{"limit_name":"special-model","rate_limit":{"allowed":false,"primary_window":{"limit_window_seconds":18000,"reset_after_seconds":3600}}}]}`
	samples := Normalize("b", "codex", []byte(body), now)
	if len(samples) != 2 {
		t.Fatalf("got %d samples: %+v", len(samples), samples)
	}
	if samples[0].Limit != "rate_limit/primary_window" || samples[0].Remaining != 99 || samples[0].WindowHours != 168 || samples[0].Reset.Unix() != 1793000000 {
		t.Fatalf("unexpected weekly sample: %+v", samples[0])
	}
	if samples[1].Limit != "model/special-model/primary_window" || samples[1].Remaining != 0 || !samples[1].Reset.Equal(now.Add(time.Hour)) || samples[1].WindowHours != 5 {
		t.Fatalf("unexpected model sample: %+v", samples[1])
	}
}

func TestNormalizePluginQuotaGroups(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	body := `{"groups":[{"displayName":"Pro","buckets":[{"window":"weekly","remainingFraction":0.4,"resetTime":"2026-10-30T00:00:00Z"},{"window":"5 hour"}]}]}`
	samples := Normalize("c", "antigravity", []byte(body), now)
	if len(samples) != 1 || samples[0].Limit != "Pro/weekly" || samples[0].Remaining != 40 || samples[0].WindowHours != 168 {
		t.Fatalf("unexpected samples: %+v", samples)
	}
	if Normalize("c", "claude", []byte("not json"), now) != nil {
		t.Fatal("invalid JSON must produce no samples")
	}
}

func TestNormalizeKimiWindowsAndMonthlyRatio(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	body := `{"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"75","resetTime":"2026-10-27T13:33:00.123456789123Z"}}],
		"usages":{"limit_month_total":{"used_ratio":0.25,"reset_time":"2026-11-28T00:00:00Z"}}}`
	samples := Normalize("k", "kimi", []byte(body), now)
	if len(samples) != 2 {
		t.Fatalf("got %d samples: %+v", len(samples), samples)
	}
	if samples[0].Limit != "limit/5h" || samples[0].Remaining != 75 || samples[0].WindowHours != 5 || samples[0].Reset.Hour() != 13 {
		t.Fatalf("unexpected window sample: %+v", samples[0])
	}
	if samples[1].Limit != "monthly" || samples[1].Remaining != 75 || samples[1].WindowHours != 720 || samples[1].Reset.Day() != 28 {
		t.Fatalf("unexpected monthly sample: %+v", samples[1])
	}
	weekly := Normalize("k", "kimi", []byte(`{"usage":{"limit":200,"used":50,"reset_in":3600}}`), now)
	if len(weekly) != 1 || weekly[0].Limit != "weekly" || weekly[0].Remaining != 75 || weekly[0].WindowHours != 168 || !weekly[0].Reset.Equal(now.Add(time.Hour)) {
		t.Fatalf("unexpected weekly sample: %+v", weekly)
	}
}
