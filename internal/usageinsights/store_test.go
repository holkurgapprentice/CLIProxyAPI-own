package usageinsights

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func TestHistoryRoutingAccountingAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	enabled := true
	s, err := NewStore(path, func() bool { return enabled })
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	r := coreusage.Record{RequestID: "execution-1", TraceID: "inbound-1", RequestedAt: at, Alias: "favorite", Model: "gpt-routed", ResponseModel: "gpt-served", Provider: "codex", APIKey: "SECRET-API-KEY", Source: "SECRET-SOURCE", AuthID: "SECRET-AUTH", AuthIndex: "index-1", Detail: coreusage.Detail{InputTokens: 100, OutputTokens: 40, CacheReadTokens: 60, ReasoningTokens: 10, TotalTokens: 140}}
	ctx := context.Background()
	s.HandleUsage(ctx, r)
	s.HandleUsage(ctx, r)
	r.RequestID = "execution-2"
	r.Provider = "claude"
	r.Failed = true
	r.Detail = coreusage.Detail{InputTokens: 20, OutputTokens: 10, CacheReadTokens: 5, CacheCreationTokens: 7, TotalTokens: 42}
	s.HandleUsage(context.Background(), r)
	enabled = false
	r.RequestID = "disabled"
	s.HandleUsage(ctx, r)
	snap := s.Snapshot(Filter{})
	if snap.Totals.Attempts != 2 || snap.Totals.Failed != 1 || snap.Totals.Total != 182 || snap.Totals.Uncached != 60 || snap.Totals.CacheRead != 65 || snap.Totals.CacheWrite != 7 || snap.Totals.Output != 40 || snap.Totals.Reasoning != 10 {
		t.Fatalf("wrong exclusive totals: %+v", snap.Totals)
	}
	if snap.CaptureEnabled {
		t.Fatalf("toggle: %+v", snap)
	}
	if got := s.Snapshot(Filter{Provider: "codex", Model: "favorite", From: at, To: at.Add(time.Hour)}); got.Totals.Attempts != 1 || got.Groups[0].Reported != "gpt-served" {
		t.Fatalf("routing/filter: %+v", got)
	}
	if got := s.Snapshot(Filter{To: at}); got.Totals.Attempts != 0 {
		t.Fatal("to must be exclusive")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"SECRET-API-KEY", "SECRET-SOURCE", "SECRET-AUTH"} {
		if contains(data, secret) {
			t.Fatal("secret persisted")
		}
	}
	reloaded, err := NewStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Snapshot(Filter{}); got.Totals != snap.Totals {
		t.Fatalf("restart changed totals: %+v", got.Totals)
	}
}

func contains(data []byte, value string) bool {
	for i := 0; i+len(value) <= len(data); i++ {
		if string(data[i:i+len(value)]) == value {
			return true
		}
	}
	return false
}

func TestRotationInterruptedWriteAndBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	s, err := NewStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := coreusage.Record{RequestID: "before", Provider: "codex", Detail: coreusage.Detail{InputTokens: 1, TotalTokens: 1}}
	s.HandleUsage(context.Background(), r)
	s.bytes = segmentBytes
	r.RequestID = "after"
	s.HandleUsage(context.Background(), r)
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"id":"partial`); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.RequestID = "recovered"
	s.HandleUsage(context.Background(), r)
	s, err = NewStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot(Filter{}); got.Totals.Attempts != 3 || got.Skipped != 1 {
		t.Fatalf("recovery: %+v", got)
	}
	for i := 0; i < MaxEvents+2; i++ {
		s.keep(Event{ID: time.Unix(int64(i), 0).String()})
	}
	if len(s.events) != MaxEvents || len(s.ids) != MaxEvents {
		t.Fatal("history unbounded")
	}
}

func TestPersistenceFailureIsVisible(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "history.jsonl")
	s, err := NewStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	s.HandleUsage(context.Background(), coreusage.Record{RequestID: "failed-write", Provider: "codex"})
	if got := s.Snapshot(Filter{}); got.PersistenceError == "" || got.Totals.Attempts != 1 {
		t.Fatal("persistence failure hidden")
	}
}
