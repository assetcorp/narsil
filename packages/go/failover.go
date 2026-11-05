package narsil

import (
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultURLSkip       = time.Second
	defaultMaxURLSkip    = 30 * time.Second
	skipDoublingCeiling  = 30
	statusBadGateway     = 502
	statusUnavailable    = 503
	statusGatewayTimeout = 504
)

type urlEntry struct {
	base      string
	position  int
	refusals  int
	skipUntil time.Time
}

func normaliseBase(raw string) (string, *Error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", configInvalid("The client needs a server address, and the URL is empty")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		failure := configInvalid("The client cannot read %q as a server address; pass an http or https URL", trimmed)
		failure.Details["url"] = trimmed
		return "", failure
	}
	return strings.TrimRight(trimmed, "/"), nil
}

type urlPool struct {
	mutex     sync.Mutex
	entries   []*urlEntry
	nextStart int
	skip      time.Duration
	maxSkip   time.Duration
}

func newURLPool(urls []string, skip, maxSkip time.Duration) (*urlPool, *Error) {
	if len(urls) == 0 {
		return nil, configInvalid("The client needs a server address, and Config.URLs lists none")
	}
	if skip < 0 || maxSkip < 0 {
		return nil, configInvalid("Config.URLSkip and Config.MaxURLSkip take 0 or more")
	}
	if skip == 0 {
		skip = defaultURLSkip
	}
	if maxSkip == 0 {
		maxSkip = max(defaultMaxURLSkip, skip)
	}
	if maxSkip < skip {
		return nil, configInvalid("Config.MaxURLSkip must be at least Config.URLSkip")
	}
	pool := &urlPool{skip: skip, maxSkip: maxSkip}
	for position, raw := range urls {
		base, failure := normaliseBase(raw)
		if failure != nil {
			return nil, failure
		}
		pool.entries = append(pool.entries, &urlEntry{base: base, position: position})
	}
	return pool, nil
}

func (p *urlPool) order(now time.Time) []*urlEntry {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	rotation := append(append([]*urlEntry{}, p.entries[p.nextStart:]...), p.entries[:p.nextStart]...)
	var open, skipped []*urlEntry
	for _, entry := range rotation {
		if entry.skipUntil.After(now) {
			skipped = append(skipped, entry)
		} else {
			open = append(open, entry)
		}
	}
	sort.SliceStable(skipped, func(left, right int) bool {
		return skipped[left].skipUntil.Before(skipped[right].skipUntil)
	})
	return append(open, skipped...)
}

func (p *urlPool) took(entry *urlEntry) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	p.nextStart = (entry.position + 1) % len(p.entries)
}

func (p *urlPool) answered(entry *urlEntry) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	entry.refusals = 0
	entry.skipUntil = time.Time{}
}

func (p *urlPool) refused(entry *urlEntry, now time.Time) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	entry.refusals++
	doublings := min(entry.refusals-1, skipDoublingCeiling)
	wait := p.skip
	for range doublings {
		if wait >= p.maxSkip {
			break
		}
		wait *= 2
	}
	entry.skipUntil = now.Add(min(wait, p.maxSkip))
}

func answersUnavailable(status int) bool {
	return status == statusBadGateway || status == statusUnavailable || status == statusGatewayTimeout
}

func movesOnAfterAnswer(status int, code string, repeatable bool) bool {
	if !answersUnavailable(status) {
		return false
	}
	return repeatable || code == codeNodeNotReady
}

func movesOnAfterFailure(failure *Error, sentNothing, repeatable bool) bool {
	switch failure.Code {
	case CodeClientRequestTimeout:
		return repeatable
	case CodeClientConnectionFailed:
		return repeatable || sentNothing
	}
	return false
}
