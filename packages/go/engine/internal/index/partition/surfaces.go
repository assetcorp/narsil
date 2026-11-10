package partition

import (
	"strings"
	"unicode/utf8"
)

type surfaceEntry struct {
	token string
	count int
}

type surfaceCandidate struct {
	surface     string
	token       string
	occurrences int
}

type surfaceRegistry struct {
	entries       map[string]*surfaceEntry
	buckets       map[rune]map[string]struct{}
	totalsByToken map[string]int
}

func newSurfaceRegistry() surfaceRegistry {
	return surfaceRegistry{entries: map[string]*surfaceEntry{}, buckets: map[rune]map[string]struct{}{}, totalsByToken: map[string]int{}}
}

func firstRuneOf(value string) rune {
	first, _ := utf8.DecodeRuneInString(value)
	return first
}

func (r *surfaceRegistry) adjustTotal(token string, delta int) {
	if delta == 0 {
		return
	}
	next := r.totalsByToken[token] + delta
	if next <= 0 {
		delete(r.totalsByToken, token)
		return
	}
	r.totalsByToken[token] = next
}

func (r *surfaceRegistry) add(surface, token string, occurrences int) {
	if surface == "" || token == "" || occurrences <= 0 || surface == token {
		return
	}
	if existing := r.entries[surface]; existing != nil {
		existing.count += occurrences
		r.adjustTotal(existing.token, occurrences)
		return
	}
	r.entries[surface] = &surfaceEntry{token: token, count: occurrences}
	first := firstRuneOf(surface)
	held := r.buckets[first]
	if held == nil {
		held = map[string]struct{}{}
		r.buckets[first] = held
	}
	held[surface] = struct{}{}
	r.adjustTotal(token, occurrences)
}

func (r *surfaceRegistry) subtract(surface string, occurrences int) {
	if occurrences <= 0 {
		return
	}
	existing := r.entries[surface]
	if existing == nil {
		return
	}
	removed := min(occurrences, existing.count)
	existing.count -= occurrences
	r.adjustTotal(existing.token, -removed)
	if existing.count > 0 {
		return
	}
	delete(r.entries, surface)
	first := firstRuneOf(surface)
	if held := r.buckets[first]; held != nil {
		delete(held, surface)
		if len(held) == 0 {
			delete(r.buckets, first)
		}
	}
}

func (r *surfaceRegistry) candidatesForPrefix(prefix string) []surfaceCandidate {
	if prefix == "" {
		return nil
	}
	held := r.buckets[firstRuneOf(prefix)]
	var results []surfaceCandidate
	for surface := range held {
		if !strings.HasPrefix(surface, prefix) {
			continue
		}
		if entry := r.entries[surface]; entry != nil {
			results = append(results, surfaceCandidate{surface: surface, token: entry.token, occurrences: entry.count})
		}
	}
	return results
}

func (r *surfaceRegistry) stemChangedTotalFor(token string) int {
	return r.totalsByToken[token]
}

func (r *surfaceRegistry) size() int {
	return len(r.entries)
}
