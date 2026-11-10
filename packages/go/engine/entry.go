package engine

import (
	"sort"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type analysisSettings struct {
	language     string
	revision     string
	tokenizer    model.Optional[string]
	stopWords    model.Optional[string]
	stopWordList model.Optional[[]string]
	generation   uint64
	customCode   bool
}

type indexEntry struct {
	name           string
	config         model.IndexConfig
	parsed         *schema.Parsed
	analyzer       *analysis.Analyzer
	analysis       analysisSettings
	handle         *persist.Handle
	durable        *persist.Durable
	vectorPaths    []string
	createdAt      uint64
	partitionCount int
	patternLimit   int
	embeddingName  string
	phraseReady    func() error

	embedMu  sync.RWMutex
	embedder model.EmbeddingAdapter

	writeMu          sync.Mutex
	watermarkLatched int

	useMu   sync.RWMutex
	retired bool

	promoted    atomic.Bool
	maintenance atomic.Int32

	settingsMu  sync.RWMutex
	sync        indexSync
	suggestions suggestionsState
	swap        swapState
}

func (entry *indexEntry) currentConfig() model.IndexConfig {
	entry.settingsMu.RLock()
	defer entry.settingsMu.RUnlock()
	return entry.config
}

func (entry *indexEntry) index() *index.Index {
	if current := entry.swap.current.Load(); current != nil {
		return current
	}
	return entry.handle.Index
}

func (entry *indexEntry) boundEmbedder() model.EmbeddingAdapter {
	entry.embedMu.RLock()
	defer entry.embedMu.RUnlock()
	return entry.embedder
}

func (entry *indexEntry) bindEmbedder(adapter model.EmbeddingAdapter) {
	entry.embedMu.Lock()
	defer entry.embedMu.Unlock()
	entry.embedder = adapter
}

func (entry *indexEntry) retire() {
	entry.useMu.Lock()
	entry.retired = true
	entry.useMu.Unlock()
}

func (entry *indexEntry) dispose() {
	if current := entry.swap.current.Load(); current != nil {
		current.StopCompactions()
	}
	if entry.handle != nil && entry.handle.Index != nil {
		entry.handle.Index.StopCompactions()
	}
	for _, path := range entry.vectorPaths {
		if field, found := entry.handle.Vectors[path]; found {
			field.Dispose()
		}
	}
}

func (entry *indexEntry) rules() schema.DocumentRules {
	return schema.DocumentRules{PatternValueLimit: entry.patternLimit, Strict: entry.config.Strict}
}

func sortedVectorPaths(parsed *schema.Parsed) []string {
	paths := make([]string, 0)
	for path := range parsed.VectorFields() {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}
