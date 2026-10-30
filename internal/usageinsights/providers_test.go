package usageinsights

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// Exercise the actual provider parsers through the history store, rather than
// pre-populating canonical counts as the dashboard demo does.
func TestProviderUsageReachesHistory(t *testing.T) {
	for _, provider := range []string{"kimi", "claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			var details []coreusage.Detail
			switch provider {
			case "kimi":
				body := []byte(`{"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60}}}`)
				details = append(details, helps.ParseOpenAIUsage(body))
				stream, ok := helps.ParseOpenAIStreamUsage(append([]byte("data: "), body...))
				if !ok {
					t.Fatal("stream usage missing")
				}
				details = append(details, stream)
			case "claude":
				body := []byte(`{"usage":{"input_tokens":40,"output_tokens":20,"cache_read_input_tokens":60,"cache_creation_input_tokens":5}}`)
				details = append(details, helps.ParseClaudeUsage(body))
				stream, ok := helps.ParseClaudeStreamUsage([]byte(`data: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":20,"cache_read_input_tokens":60,"cache_creation_input_tokens":5}}}`))
				if !ok {
					t.Fatal("stream usage missing")
				}
				details = append(details, stream)
			case "codex":
				body := []byte(`{"response":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":60}}}}`)
				detail, ok := helps.ParseCodexUsage(body)
				if !ok {
					t.Fatal("response usage missing")
				}
				details = append(details, detail)
			}
			for i, detail := range details {
				s, err := NewStore(filepath.Join(t.TempDir(), "usage.jsonl"), nil)
				if err != nil {
					t.Fatal(err)
				}
				s.HandleUsage(context.Background(), coreusage.Record{RequestID: "execution", Provider: provider, Model: "served", Alias: "picked", Detail: detail})
				got := s.Snapshot(Filter{}).Totals
				wantTotal := int64(120)
				wantWrite := int64(0)
				if provider == "claude" {
					wantTotal = 125
					wantWrite = 5
				}
				if got.Attempts != 1 || got.Uncached != 40 || got.CacheRead != 60 || got.CacheWrite != wantWrite || got.Output != 20 || got.Total != wantTotal || got.NoReportedTokens != 0 {
					t.Fatalf("path %d: %+v", i, got)
				}
			}
		})
	}
}

func TestAttemptCountIndependentOfTokenReporting(t *testing.T) {
	s, err := NewStore(filepath.Join(t.TempDir(), "usage.jsonl"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []coreusage.Record{{RequestID: "first", TraceID: "same-client-request", Model: "picked", Failed: true}, {RequestID: "retry", TraceID: "same-client-request", Model: "picked"}} {
		s.HandleUsage(context.Background(), r)
	}
	got := s.Snapshot(Filter{}).Totals
	if got.Attempts != 2 || got.Failed != 1 || got.NoReportedTokens != 2 {
		t.Fatalf("missing usage must not hide attempts: %+v", got)
	}
}
