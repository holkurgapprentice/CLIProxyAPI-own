package quotaoutlook

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
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
	case "kimi":
		// Mirrors the console: per-window limits, a weekly usage summary and a monthly ratio.
		bucket := func(label string, b gjson.Result, hours float64) {
			limit, okLimit := number(b.Get("limit"))
			used, okUsed := number(b.Get("used"))
			if left, okLeft := number(b.Get("remaining")); !okUsed && okLeft && okLimit {
				used, okUsed = limit-left, true
			}
			if !okLimit || !okUsed || limit <= 0 {
				return
			}
			add(label, math.Max(0, math.Min(100, 100*(limit-used)/limit)), kimiReset(b, now), hours)
		}
		for i, item := range root.Get("limits").Array() {
			detail, window := item, item.Get("window")
			if item.Get("detail").IsObject() {
				detail = item.Get("detail")
			}
			name := ""
			for _, source := range []gjson.Result{item, detail} {
				if name == "" {
					name = strings.TrimSpace(first(source, "name", "title", "scope").String())
				}
			}
			duration, okDuration := number(first(window, "duration"))
			if !okDuration {
				duration, okDuration = number(first(item, "duration"))
			}
			if !okDuration {
				duration, okDuration = number(first(detail, "duration"))
			}
			unit := first(window, "timeUnit")
			if !unit.Exists() {
				unit = first(item, "timeUnit")
			}
			if !unit.Exists() {
				unit = first(detail, "timeUnit")
			}
			hours := -1.0
			if okDuration && duration > 0 {
				hours = kimiHours(duration, unit.String())
			}
			if hours < 0 {
				hours = namedWindowHours(name)
			}
			label := name
			if label == "" && hours > 0 {
				label = strconv.FormatFloat(hours, 'f', -1, 64) + "h"
			}
			if label == "" {
				label = strconv.Itoa(i)
			}
			bucket("limit/"+label, detail, hours)
		}
		if usage := root.Get("usage"); usage.IsObject() {
			bucket("weekly", usage, 168)
		}
		if month := root.Get("usages.limit_month_total"); month.IsObject() {
			if ratio, ok := number(month.Get("used_ratio")); ok {
				add("monthly", math.Max(0, math.Min(100, 100-100*ratio)), kimiReset(month, now), 720)
			}
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

// number accepts JSON numbers and numeric strings.
func number(value gjson.Result) (float64, bool) {
	switch value.Type {
	case gjson.Number:
		return value.Float(), true
	case gjson.String:
		parsed, errParse := strconv.ParseFloat(strings.TrimSpace(value.String()), 64)
		return parsed, errParse == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	}
	return 0, false
}

// kimiHours converts a Kimi window duration; minutes are the default unit. Unknown units return -1.
func kimiHours(duration float64, unit string) float64 {
	switch strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(unit)), "TIME_UNIT_") {
	case "SECOND", "SECONDS":
		return duration / 3600
	case "", "MINUTE", "MINUTES":
		return duration / 60
	case "HOUR", "HOURS":
		return duration
	case "DAY", "DAYS":
		return duration * 24
	case "WEEK", "WEEKS":
		return duration * 168
	}
	return -1
}

// namedWindowHours guesses a window length from its label, as the console does.
func namedWindowHours(name string) float64 {
	name = strings.ToLower(name)
	switch {
	case strings.Contains(name, "day"):
		return 24
	case strings.Contains(name, "week"):
		return 168
	case strings.Contains(name, "month"):
		return 720
	case strings.Contains(name, "5h"), strings.Contains(name, "hour"):
		return 5
	}
	return 0
}

// kimiReset reads an absolute reset time or a countdown in seconds.
func kimiReset(value gjson.Result, now time.Time) time.Time {
	if reset := resetTime(first(value, "reset_at", "resetAt", "reset_time", "resetTime")); !reset.IsZero() {
		return reset
	}
	if seconds, ok := number(first(value, "reset_in", "resetIn", "ttl")); ok && seconds > 0 {
		return now.Add(time.Duration(seconds * float64(time.Second))).UTC()
	}
	return time.Time{}
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
