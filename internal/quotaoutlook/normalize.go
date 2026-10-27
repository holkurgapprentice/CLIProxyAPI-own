package quotaoutlook

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/tidwall/gjson"
)

var (
	weeklyWindow   = regexp.MustCompile(`(?i)week|7.?day`)
	fiveHourWindow = regexp.MustCompile(`(?i)5.?hour`)
)

// Normalize converts a provider quota response into percentage samples.
// Claude and Codex bodies are raw usage responses; other providers use the plugin quota groups format.
// Only limit names, percentages and reset times are kept, never credential material.
func Normalize(account, provider string, body []byte, now time.Time) []Sample {
	if !gjson.ValidBytes(body) {
		return nil
	}
	root := gjson.ParseBytes(body)
	var result []Sample
	add := func(limit string, remaining float64, reset time.Time, windowHours float64) {
		if math.IsNaN(remaining) || remaining < 0 || remaining > 100 || limit == "" || len(limit) > 160 {
			return
		}
		if math.IsNaN(windowHours) || math.IsInf(windowHours, 0) || windowHours < 0 || windowHours > 24*366 {
			windowHours = 0
		}
		result = append(result, Sample{Account: account, Provider: provider, Limit: limit, Remaining: remaining, Reset: reset, WindowHours: windowHours, At: now.UTC()})
	}
	switch provider {
	case "claude":
		root.ForEach(func(name, bucket gjson.Result) bool {
			utilization := bucket.Get("utilization")
			if !bucket.IsObject() || utilization.Type != gjson.Number {
				return true
			}
			hours := 0.0
			if strings.HasPrefix(name.String(), "seven_day") {
				hours = 168
			} else if name.String() == "five_hour" {
				hours = 5
			}
			add(name.String(), 100-utilization.Float(), resetTime(bucket.Get("resets_at")), hours)
			return true
		})
	case "codex":
		group := func(name string, value gjson.Result) {
			if !value.IsObject() {
				return
			}
			for _, window := range []string{"primary_window", "secondary_window"} {
				bucket := value.Get(window)
				if !bucket.IsObject() {
					continue
				}
				used := first(bucket, "used_percent", "usedPercent")
				remaining := math.NaN()
				if used.Type == gjson.Number {
					remaining = 100 - used.Float()
				} else if value.Get("limit_reached").Bool() || value.Get("allowed").Type == gjson.False {
					remaining = 0
				}
				reset := resetTime(first(bucket, "reset_at", "resetAt"))
				if after := first(bucket, "reset_after_seconds", "resetAfterSeconds"); reset.IsZero() && after.Type == gjson.Number {
					reset = now.Add(time.Duration(after.Float() * float64(time.Second))).UTC()
				}
				add(name+"/"+window, remaining, reset, first(bucket, "limit_window_seconds", "limitWindowSeconds").Float()/3600)
			}
		}
		root.ForEach(func(name, value gjson.Result) bool {
			group(name.String(), value)
			return true
		})
		for i, value := range first(root, "additional_rate_limits", "additionalRateLimits").Array() {
			label := first(value, "limit_name", "limitName", "metered_feature", "meteredFeature").String()
			if label == "" {
				label = fmt.Sprint(i)
			}
			group("model/"+label, first(value, "rate_limit", "rateLimit"))
		}
	default:
		for gi, g := range root.Get("groups").Array() {
			name := first(g, "displayName", "display_name").String()
			if name == "" {
				name = fmt.Sprintf("group %d", gi)
			}
			for bi, b := range g.Get("buckets").Array() {
				window := b.Get("window").String()
				if window == "" {
					window = fmt.Sprintf("window %d", bi)
				}
				hours := 0.0
				if weeklyWindow.MatchString(window) {
					hours = 168
				} else if fiveHourWindow.MatchString(window) {
					hours = 5
				}
				fraction := first(b, "remainingFraction", "remaining_fraction")
				if fraction.Type != gjson.Number {
					continue
				}
				add(name+"/"+window, 100*fraction.Float(), resetTime(first(b, "resetTime", "reset_time")), hours)
			}
		}
	}
	return result
}

func first(value gjson.Result, names ...string) gjson.Result {
	for _, name := range names {
		if result := value.Get(name); result.Exists() && result.Type != gjson.Null {
			return result
		}
	}
	return gjson.Result{}
}

// resetTime accepts RFC 3339 strings and Unix seconds.
func resetTime(value gjson.Result) time.Time {
	switch value.Type {
	case gjson.Number:
		seconds := value.Float()
		if seconds <= 0 {
			return time.Time{}
		}
		return time.Unix(0, int64(seconds*float64(time.Second))).UTC()
	case gjson.String:
		if parsed, errParse := time.Parse(time.RFC3339Nano, value.String()); errParse == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}
