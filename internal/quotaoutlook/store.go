// Package quotaoutlook stores quota observations without credential material.
package quotaoutlook

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const Retention = 14 * 24 * time.Hour
const MaxSamples = 50000

type Sample struct {
	Account     string    `json:"account"`
	Provider    string    `json:"provider"`
	Limit       string    `json:"limit"`
	Remaining   float64   `json:"remaining"`
	Reset       time.Time `json:"reset"`
	WindowHours float64   `json:"windowHours"`
	At          time.Time `json:"at"`
	// Usage is the credential's cumulative price-weighted token counter within Epoch.
	Usage float64 `json:"usage,omitempty"`
	Epoch string  `json:"epoch,omitempty"`
	Plan  string  `json:"plan,omitempty"`
}

type Store struct {
	mu   sync.Mutex
	path string
}

func NewStore(path string) *Store { return &Store{path: path} }

func (s *Store) read(now time.Time) ([]Sample, error) {
	samples := []Sample{}
	data, errRead := os.ReadFile(s.path)
	if os.IsNotExist(errRead) {
		return samples, nil
	}
	if errRead != nil {
		return nil, fmt.Errorf("read quota history: %w", errRead)
	}
	if errJSON := json.Unmarshal(data, &samples); errJSON != nil {
		return nil, fmt.Errorf("decode quota history: %w", errJSON)
	}
	kept := make([]Sample, 0, len(samples))
	for _, sample := range samples {
		if !sample.At.Before(now.Add(-Retention)) {
			kept = append(kept, sample)
		}
	}
	return kept, nil
}

func (s *Store) Read(now time.Time) ([]Sample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(now)
}

func (s *Store) Append(batch []Sample, now time.Time) ([]Sample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sample := range batch {
		if sample.Account == "" || len(sample.Account) > 128 || sample.Provider == "" || len(sample.Provider) > 64 || sample.Limit == "" || len(sample.Limit) > 160 || math.IsNaN(sample.Remaining) || math.IsInf(sample.Remaining, 0) || sample.Remaining < 0 || sample.Remaining > 100 || math.IsNaN(sample.WindowHours) || math.IsInf(sample.WindowHours, 0) || sample.WindowHours < 0 || sample.WindowHours > 24*366 || math.IsNaN(sample.Usage) || math.IsInf(sample.Usage, 0) || sample.Usage < 0 || len(sample.Epoch) > 32 || len(sample.Plan) > 32 {
			return nil, fmt.Errorf("invalid quota observation")
		}
	}
	samples, errRead := s.read(now)
	if errRead != nil {
		return nil, errRead
	}
	for _, sample := range batch {
		sample.At = now.UTC()
		// Ignore rapid duplicate polls, but keep changed limits and reset boundaries.
		duplicate := false
		for i := len(samples) - 1; i >= 0; i-- {
			previous := samples[i]
			if previous.Account == sample.Account && previous.Provider == sample.Provider && previous.Limit == sample.Limit {
				duplicate = now.Sub(previous.At) < time.Minute && previous.Remaining == sample.Remaining && previous.Reset.Equal(sample.Reset)
				break
			}
		}
		if !duplicate {
			samples = append(samples, sample)
		}
	}
	if len(samples) > MaxSamples {
		samples = samples[len(samples)-MaxSamples:]
	}
	data, errJSON := json.Marshal(samples)
	if errJSON != nil {
		return nil, errJSON
	}
	if errWrite := os.WriteFile(s.path+".tmp", data, 0600); errWrite != nil {
		return nil, fmt.Errorf("write quota history: %w", errWrite)
	}
	// Windows briefly denies replacing a file that another process, such as a virus scanner, still has open.
	var errRename error
	for attempt := 1; attempt <= 5; attempt++ {
		if errRename = os.Rename(s.path+".tmp", s.path); errRename == nil {
			break
		}
		time.Sleep(time.Duration(attempt) * 20 * time.Millisecond)
	}
	if errRename != nil {
		return nil, fmt.Errorf("replace quota history: %w", errRename)
	}
	return samples, nil
}

func HistoryPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "quota-history.json")
}
