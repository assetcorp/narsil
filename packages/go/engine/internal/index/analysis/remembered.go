package analysis

import (
	"errors"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

var ErrTokensNotKept = errors.New("the engine needs tokens that the tokenizer has not produced outside the engine's locks")

type MissedTokens struct {
	Sources []string
}

func (e *MissedTokens) Error() string {
	return ErrTokensNotKept.Error()
}

func (e *MissedTokens) Is(target error) bool {
	return target == ErrTokensNotKept
}

func MissedIn(pass *Pass) error {
	if pass == nil {
		return nil
	}
	if missed := pass.Missed(); len(missed) > 0 {
		return &MissedTokens{Sources: missed}
	}
	return nil
}

type rememberedTokenization struct {
	tokens []model.Token
	err    error
}

type rememberedTokens struct {
	mu      sync.Mutex
	entries map[string]rememberedTokenization
}

func (r *rememberedTokens) lookup(source string) (rememberedTokenization, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	held, found := r.entries[source]
	return held, found
}

func (r *rememberedTokens) keep(source string, tokens []model.Token, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, found := r.entries[source]; !found {
		r.entries[source] = rememberedTokenization{tokens: append([]model.Token(nil), tokens...), err: err}
	}
}

type missMode uint8

const (
	tokenizesOnMiss missMode = iota
	refusesOnMiss
	collectsOnMiss
)

type missedSources struct {
	mu      sync.Mutex
	seen    map[string]struct{}
	ordered []string
}

func (m *missedSources) add(source string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, found := m.seen[source]; !found {
		m.seen[source] = struct{}{}
		m.ordered = append(m.ordered, source)
	}
}

func (m *missedSources) list() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.ordered...)
}

func (p *Pass) Remembering() *Pass {
	if p.analyzer.tokenizer == nil || p.remembered != nil {
		return p
	}
	return &Pass{analyzer: p.analyzer, stops: p.stops,
		remembered: &rememberedTokens{entries: map[string]rememberedTokenization{}}}
}

func (p *Pass) withMissMode(mode missMode) *Pass {
	remembering := p.Remembering()
	return &Pass{analyzer: remembering.analyzer, stops: remembering.stops, remembered: remembering.remembered,
		miss: mode, missed: &missedSources{seen: map[string]struct{}{}}}
}

func (p *Pass) KeptOnly() *Pass {
	return p.withMissMode(refusesOnMiss)
}

func (p *Pass) Collecting() *Pass {
	return p.withMissMode(collectsOnMiss)
}

func (p *Pass) Missed() []string {
	if p.missed == nil {
		return nil
	}
	return p.missed.list()
}

func (p *Pass) Remember(sources []string) {
	remembering := p.Remembering()
	tokenizing := &Pass{analyzer: remembering.analyzer, stops: remembering.stops, remembered: remembering.remembered}
	if tokenizing.analyzer.tokenizer == nil {
		return
	}
	for _, source := range sources {
		_, _ = tokenizing.customTokens(source)
	}
}

func (p *Pass) Absorb(other *Pass) int {
	if p == nil || p.remembered == nil || other == nil || other.remembered == nil || other.analyzer != p.analyzer ||
		other.remembered == p.remembered {
		return 0
	}
	other.remembered.mu.Lock()
	held := make(map[string]rememberedTokenization, len(other.remembered.entries))
	for source, tokenization := range other.remembered.entries {
		held[source] = tokenization
	}
	other.remembered.mu.Unlock()
	p.remembered.mu.Lock()
	defer p.remembered.mu.Unlock()
	added := 0
	for source, tokenization := range held {
		if _, found := p.remembered.entries[source]; !found {
			p.remembered.entries[source] = tokenization
			added++
		}
	}
	return added
}

func (p *Pass) Of(analyzer *Analyzer) bool {
	return p != nil && p.analyzer == analyzer
}

func (p *Pass) missedTokens(source string) ([]model.Token, error) {
	p.missed.add(source)
	if p.miss == refusesOnMiss {
		return nil, ErrTokensNotKept
	}
	return nil, nil
}
