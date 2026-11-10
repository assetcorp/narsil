package engine

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type adapterRegistry struct {
	mu        sync.RWMutex
	fallback  model.EmbeddingAdapter
	embedding map[string]model.EmbeddingAdapter
	rerank    map[string]model.RerankAdapter
	analysis  *analysis.Registry
}

func newAdapterRegistry(config model.Config) (*adapterRegistry, error) {
	registry := &adapterRegistry{
		fallback:  config.Embedding,
		embedding: map[string]model.EmbeddingAdapter{},
		rerank:    map[string]model.RerankAdapter{},
		analysis:  analysis.NewRegistry(),
	}
	if config.Embedding != nil {
		if dimensions := safeDimensions(config.Embedding); dimensions <= 0 {
			return nil, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
				fmt.Sprintf("Adapter dimensions must be a positive integer, got %d", dimensions), nil)
		}
	}
	for _, name := range sortedNames(config.EmbeddingAdapters) {
		adapter := config.EmbeddingAdapters[name]
		if err := schema.ValidateRegisteredEmbeddingAdapter(name, guardedEmbedder(adapter)); err != nil {
			return nil, err
		}
		registry.embedding[name] = adapter
	}
	for _, name := range sortedNames(config.RerankAdapters) {
		if err := validateRerankAdapter(name, config.RerankAdapters[name]); err != nil {
			return nil, err
		}
		registry.rerank[name] = config.RerankAdapters[name]
	}
	for _, name := range sortedNames(config.Tokenizers) {
		if err := registry.analysis.RegisterTokenizer(name, config.Tokenizers[name]); err != nil {
			return nil, err
		}
	}
	for _, name := range sortedNames(config.StopWordSets) {
		if err := registry.analysis.RegisterStopWords(name, config.StopWordSets[name]); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

func sortedNames[V any](values map[string]V) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func guardedEmbedder(adapter model.EmbeddingAdapter) model.EmbeddingAdapter {
	if adapter == nil {
		return nil
	}
	return safeEmbedder{adapter: adapter}
}

func validateRerankAdapter(name string, adapter model.RerankAdapter) error {
	if strings.TrimSpace(name) == "" {
		return narsilerr.New(narsilerr.CodeRerankConfigInvalid, "A rerank adapter needs a non-empty string name", map[string]any{})
	}
	if adapter == nil {
		return narsilerr.New(narsilerr.CodeRerankConfigInvalid, fmt.Sprintf("Rerank adapter %q must provide a rerank function", name),
			map[string]any{"adapter": name})
	}
	return nil
}

func (registry *adapterRegistry) rerankerNames() []string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return sortedNames(registry.rerank)
}

func (registry *adapterRegistry) embedder(name string) (model.EmbeddingAdapter, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	adapter, found := registry.embedding[name]
	return adapter, found
}

func (registry *adapterRegistry) embedderNames() []string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return sortedNames(registry.embedding)
}

func (registry *adapterRegistry) reranker(name string) (model.RerankAdapter, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	adapter, found := registry.rerank[name]
	return adapter, found
}

func (registry *adapterRegistry) shutdown(ctx context.Context) []error {
	registry.mu.RLock()
	seen := map[any]struct{}{}
	var closers []model.AdapterShutdown
	collect := func(candidate any) {
		closer, closes := candidate.(model.AdapterShutdown)
		if !closes {
			return
		}
		if _, done := seen[candidate]; done {
			return
		}
		seen[candidate] = struct{}{}
		closers = append(closers, closer)
	}
	if registry.fallback != nil {
		collect(registry.fallback)
	}
	for _, name := range sortedNames(registry.embedding) {
		collect(registry.embedding[name])
	}
	for _, name := range sortedNames(registry.rerank) {
		collect(registry.rerank[name])
	}
	registry.mu.RUnlock()
	var failures []error
	for _, closer := range closers {
		if err := shutdownSafely(ctx, closer); err != nil {
			failures = append(failures, err)
		}
	}
	return failures
}

func shutdownSafely(ctx context.Context, closer model.AdapterShutdown) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("an adapter panicked while shutting down: %v", recovered)
		}
	}()
	return closer.Shutdown(ctx)
}

// RegisterEmbeddingAdapter binds adapter to name, so that an index whose
// embedding configuration names that adapter embeds with it. Every index
// that already names it binds it at once, and an index restored or
// recovered later finds it by name, because a snapshot and a checkpoint keep
// the name and never the adapter. The engine refuses the adapter with
// CodeEmbeddingConfigInvalid when the name is blank or its dimensions are
// not positive, and with the code of the mismatch when an index that names
// it declares vector fields of another dimension.
func (n *Narsil) RegisterEmbeddingAdapter(name string, adapter EmbeddingAdapter) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	if err := schema.ValidateRegisteredEmbeddingAdapter(name, guardedEmbedder(adapter)); err != nil {
		return err
	}
	entries := n.sortedEntries()
	affected := make([]*indexEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.embeddingName != name || entry.config.Embedding == nil {
			continue
		}
		_, err := schema.ValidateEmbeddingConfig(entry.config.Embedding.Fields, guardedEmbedder(adapter), nil, entry.parsed)
		if err != nil {
			code := narsilerr.CodeOf(err)
			message := err.Error()
			if engineError, isEngineError := narsilerr.As(err); isEngineError {
				message = engineError.Message
			}
			return narsilerr.New(code, fmt.Sprintf("Cannot bind embedding adapter %q to index %q: %s", name, entry.name, message),
				map[string]any{"indexName": entry.name, "adapter": name})
		}
		affected = append(affected, entry)
	}
	n.adapters.mu.Lock()
	n.adapters.embedding[name] = adapter
	n.adapters.mu.Unlock()
	for _, entry := range affected {
		entry.bindEmbedder(adapter)
	}
	return nil
}

// RegisterRerankAdapter binds adapter to name, so that a query whose rerank
// configuration names it reorders its leading hits with that adapter. The
// engine refuses a blank name or a nil adapter with CodeRerankConfigInvalid.
func (n *Narsil) RegisterRerankAdapter(name string, adapter RerankAdapter) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	if err := validateRerankAdapter(name, adapter); err != nil {
		return err
	}
	n.adapters.mu.Lock()
	n.adapters.rerank[name] = adapter
	n.adapters.mu.Unlock()
	return nil
}

// RegisterTokenizer binds tokenizer to name for this engine, so that an index
// configured with NamedTokenizer(name) splits its text with it. An index
// that keeps its data durably can only use a tokenizer this way, because a
// checkpoint keeps the name and never the code; register the tokenizer in
// Config.Tokenizers so that recovery finds it as New starts. The engine
// refuses a blank name or a nil tokenizer with CodeConfigInvalid.
func (n *Narsil) RegisterTokenizer(name string, tokenizer Tokenizer) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	return n.adapters.analysis.RegisterTokenizer(name, tokenizer)
}

// RegisterStopWords binds a stop word list or function to name for this
// engine, so that an index configured with NamedStopWords(name) drops those
// words. Register the set in Config.StopWordSets so that recovery finds it as
// New starts. The engine refuses a blank name or an empty setting with
// CodeConfigInvalid.
func (n *Narsil) RegisterStopWords(name string, stopWords StopWords) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	return n.adapters.analysis.RegisterStopWords(name, stopWords)
}
