// Package usageinsights keeps bounded, credential-free execution history.
package usageinsights

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

const MaxEvents = 100000
const segmentBytes = 32 << 20

type Event struct {
	ID        string                   `json:"id"`
	Trace     string                   `json:"trace,omitempty"`
	At        time.Time                `json:"at"`
	Requested string                   `json:"requested"`
	Routed    string                   `json:"routed"`
	Reported  string                   `json:"reported,omitempty"`
	Provider  string                   `json:"provider"`
	Account   string                   `json:"account,omitempty"`
	Failed    bool                     `json:"failed"`
	Stream    bool                     `json:"stream"`
	LatencyMS int64                    `json:"latency_ms"`
	Tier      string                   `json:"tier,omitempty"`
	Tokens    coreusage.TokenBreakdown `json:"tokens"`
}

type Store struct {
	mu        sync.Mutex
	path      string
	events    []Event
	next      int
	ids       map[string]bool
	bytes     int64
	lastError string
	skipped   int
	enabled   func() bool
}

func NewStore(path string, enabled func() bool) (*Store, error) {
	s := &Store{path: path, ids: map[string]bool{}, enabled: enabled}
	for _, name := range []string{path + ".1", path} {
		if err := s.load(name); err != nil {
			return nil, err
		}
	}
	if info, err := os.Stat(path); err == nil {
		s.bytes = info.Size()
	}
	return s, nil
}

func (s *Store) load(path string) (errResult error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open usage history: %w", err)
	}
	defer func() {
		if err := f.Close(); errResult == nil && err != nil {
			errResult = err
		}
	}()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		var e Event
		if json.Unmarshal(scanner.Bytes(), &e) != nil || e.ID == "" || !e.Tokens.Valid() {
			s.skipped++
			continue
		}
		s.keep(e)
	}
	return scanner.Err()
}

func (s *Store) keep(e Event) bool {
	if s.ids[e.ID] {
		return false
	}
	if len(s.events) < MaxEvents {
		s.events = append(s.events, e)
	} else {
		delete(s.ids, s.events[s.next].ID)
		s.events[s.next] = e
		s.next = (s.next + 1) % MaxEvents
	}
	s.ids[e.ID] = true
	return true
}

// HandleUsage receives completed execution attempts, including failed retries.
// Disk writes run on the existing asynchronous usage dispatcher, outside HTTP execution.
func (s *Store) HandleUsage(ctx context.Context, r coreusage.Record) {
	if s.enabled != nil && !s.enabled() {
		return
	}
	at := r.RequestedAt
	if at.IsZero() {
		at = time.Now()
	}
	requested := r.Alias
	if requested == "" {
		requested = coreusage.RequestedModelAliasFromContext(ctx)
	}
	if requested == "" {
		requested = r.Model
	}
	e := Event{ID: r.RequestID, Trace: r.TraceID, At: at.UTC(), Requested: requested, Routed: r.Model, Reported: r.ResponseModel, Provider: r.Provider, Account: r.AuthIndex, Failed: r.Failed, Stream: r.Stream, LatencyMS: r.Latency.Milliseconds(), Tier: r.ResponseServiceTier, Tokens: coreusage.EnsureTokenBreakdownForProvider(r.Detail, r.Provider, r.ExecutorType).TokenBreakdown}
	if e.ID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.keep(e) {
		return
	}
	if err := s.append(e); err != nil {
		s.lastError = err.Error()
	} else {
		s.lastError = ""
	}
}

func (s *Store) append(e Event) (errResult error) {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	if s.bytes+int64(len(data)+2) > segmentBytes {
		if err := os.Remove(s.path + ".1"); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(s.path, s.path+".1"); err != nil {
			return err
		}
		s.bytes = 0
	}
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		if err := f.Close(); errResult == nil && err != nil {
			errResult = err
		}
	}()
	// A leading newline isolates an interrupted final write from the next record.
	data = append(append([]byte{'\n'}, data...), '\n')
	n, err := f.Write(data)
	s.bytes += int64(n)
	return err
}

type Filter struct {
	From, To        time.Time
	Provider, Model string
}

type Counts struct {
	NoReportedTokens int64 `json:"no_reported_tokens"`
	Attempts         int64 `json:"attempts"`
	Failed           int64 `json:"failed"`
	CacheHits        int64 `json:"cache_hits"`
	Total            int64 `json:"total"`
	Uncached         int64 `json:"uncached"`
	CacheRead        int64 `json:"cache_read"`
	CacheWrite       int64 `json:"cache_write"`
	Output           int64 `json:"output"`
	Reasoning        int64 `json:"reasoning"`
	Unclassified     int64 `json:"unclassified"`
	Uncertain        int64 `json:"uncertain"`
}

func (c *Counts) add(e Event) {
	c.Attempts++
	if e.Tokens.TotalTokens == 0 {
		c.NoReportedTokens++
	}
	if e.Failed {
		c.Failed++
	}
	b := e.Tokens
	if b.Input.CacheReadTokens > 0 {
		c.CacheHits++
	}
	c.Total += b.TotalTokens
	c.Uncached += b.Input.UncachedTokens
	c.CacheRead += b.Input.CacheReadTokens
	c.CacheWrite += b.Input.CacheWriteTokens
	c.Output += b.Output.NonReasoningTokens
	c.Reasoning += b.Output.ReasoningTokens
	c.Unclassified += b.UnclassifiedTokens
	if b.Quality != coreusage.TokenAccountingQualityComplete {
		c.Uncertain++
	}
}

type Group struct {
	Requested string `json:"requested"`
	Routed    string `json:"routed"`
	Reported  string `json:"reported,omitempty"`
	Provider  string `json:"provider"`
	Counts
}

type Bucket struct {
	At       time.Time `json:"at"`
	Provider string    `json:"provider"`
	Counts
}

type Snapshot struct {
	Totals           Counts     `json:"totals"`
	Groups           []Group    `json:"groups"`
	Timeline         []Bucket   `json:"timeline"`
	Recent           []Event    `json:"recent"`
	Retained         int        `json:"retained"`
	Oldest           *time.Time `json:"oldest,omitempty"`
	PersistenceError string     `json:"persistence_error,omitempty"`
	Skipped          int        `json:"skipped_records"`
	CaptureEnabled   bool       `json:"capture_enabled"`
}

// Events returns detached records in arrival order without consuming the queue.
func (s *Store) Events(f Filter) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.filtered(f)
}

func (s *Store) filtered(f Filter) []Event {
	out := make([]Event, 0)
	for i := 0; i < len(s.events); i++ {
		e := s.events[(s.next+i)%len(s.events)]
		if !f.From.IsZero() && e.At.Before(f.From) || !f.To.IsZero() && !e.At.Before(f.To) || f.Provider != "" && e.Provider != f.Provider || f.Model != "" && e.Requested != f.Model {
			continue
		}
		out = append(out, e)
	}
	return out
}

func (s *Store) Snapshot(f Filter) Snapshot {
	s.mu.Lock()
	events := s.filtered(f)
	out := Snapshot{Retained: len(s.events), PersistenceError: s.lastError, Skipped: s.skipped, CaptureEnabled: s.enabled == nil || s.enabled(), Groups: []Group{}, Timeline: []Bucket{}, Recent: []Event{}}
	for _, e := range s.events {
		if out.Oldest == nil || e.At.Before(*out.Oldest) {
			at := e.At
			out.Oldest = &at
		}
	}
	s.mu.Unlock()
	groups := map[[4]string]*Group{}
	buckets := map[string]*Bucket{}
	for _, e := range events {
		out.Totals.add(e)
		key := [4]string{e.Requested, e.Routed, e.Reported, e.Provider}
		g := groups[key]
		if g == nil {
			g = &Group{Requested: e.Requested, Routed: e.Routed, Reported: e.Reported, Provider: e.Provider}
			groups[key] = g
		}
		g.add(e)
		at := e.At.Truncate(time.Hour)
		bk := at.Format(time.RFC3339) + "/" + e.Provider
		b := buckets[bk]
		if b == nil {
			b = &Bucket{At: at, Provider: e.Provider}
			buckets[bk] = b
		}
		b.add(e)
	}
	for _, g := range groups {
		out.Groups = append(out.Groups, *g)
	}
	for _, b := range buckets {
		out.Timeline = append(out.Timeline, *b)
	}
	for i := len(events) - 1; i >= 0 && len(out.Recent) < 100; i-- {
		out.Recent = append(out.Recent, events[i])
	}
	return out
}
