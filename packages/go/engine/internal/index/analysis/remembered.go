package analysis

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

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

func (p *Pass) Remembering() *Pass {
	if p.analyzer.tokenizer == nil || p.remembered != nil {
		return p
	}
	return &Pass{analyzer: p.analyzer, stops: p.stops,
		remembered: &rememberedTokens{entries: map[string]rememberedTokenization{}}}
}
