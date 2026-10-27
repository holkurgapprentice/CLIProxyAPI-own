package quotaoutlook

import (
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestHistoryPersistsAndExcludesExpiredSamples(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "quota-history.json")
	store := NewStore(path)
	sample := Sample{Account: "opaque-index", Provider: "claude", Limit: "seven_day", Remaining: 70, Reset: now.Add(24 * time.Hour), WindowHours: 168}
	if _, err := store.Append([]Sample{sample}, now.Add(-Retention-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append([]Sample{sample}, now); err != nil {
		t.Fatal(err)
	}
	got, err := NewStore(path).Read(now)
	if err != nil || len(got) != 1 || !got[0].At.Equal(now) || got[0].Remaining != 70 {
		t.Fatalf("history after restart = %+v, %v", got, err)
	}
	if _, err = store.Append([]Sample{sample}, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Read(now)
	if len(got) != 1 {
		t.Fatal("duplicate poll added observation")
	}
	sample.Remaining = 60
	got, err = store.Append([]Sample{sample}, now.Add(time.Second))
	if err != nil || len(got) != 2 {
		t.Fatalf("changed observation lost: %v", err)
	}
}

func TestHistoryRejectsInvalidBatchAndPreservesCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quota-history.json")
	store := NewStore(path)
	now := time.Now()
	valid := Sample{Account: "a", Provider: "codex", Limit: "weekly", Remaining: 50}
	for _, value := range []float64{-1, 101, math.NaN(), math.Inf(1)} {
		invalid := valid
		invalid.Remaining = value
		if _, err := store.Append([]Sample{valid, invalid}, now); err == nil {
			t.Fatalf("accepted %v", value)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("invalid batch wrote history")
		}
	}
	raw := []byte("broken history")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append([]Sample{valid}, now); err == nil {
		t.Fatal("overwrote corrupt history")
	}
	data, _ := os.ReadFile(path)
	if string(data) != string(raw) {
		t.Fatal("corrupt file changed")
	}
}

func TestHistorySerializesConcurrentWriters(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "quota-history.json"))
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := store.Append([]Sample{{Account: "a", Provider: "claude", Limit: "weekly", Remaining: float64(i)}}, now)
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	got, err := store.Read(now)
	if err != nil || len(got) != 20 {
		t.Fatalf("lost concurrent observations: %d %v", len(got), err)
	}
}
