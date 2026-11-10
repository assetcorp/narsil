package engine

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type staleTerms struct {
	storedRevision model.Optional[string]
	storedGap      model.Optional[uint32]
	staleGap       bool
}

type swapState struct {
	current atomic.Pointer[index.Index]
	base    index.Settings

	mu        sync.Mutex
	rebalance *rebalanceRun
	log       *rebuildLog
	change    *changeRun
	pending   *metadata.PendingAnalysis
	restores  int
	stale     *staleTerms
	rebuild   *staleRebuild
	promoted  bool
}

func (state *swapState) adopt(built *index.Index, settings index.Settings) {
	state.current.Store(built)
	state.base = settings
}

func (entry *indexEntry) currentAnalysis() analysisSettings {
	entry.settingsMu.RLock()
	defer entry.settingsMu.RUnlock()
	return entry.analysis
}

func (entry *indexEntry) currentAnalyzer() *analysis.Analyzer {
	entry.settingsMu.RLock()
	defer entry.settingsMu.RUnlock()
	return entry.analyzer
}

func (entry *indexEntry) pendingAnalysisMetadata() *metadata.PendingAnalysis {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.pending == nil {
		return nil
	}
	pending := *entry.swap.pending
	return &pending
}

func (entry *indexEntry) recordedGap() model.Optional[uint32] {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.stale != nil && entry.swap.stale.staleGap {
		return entry.swap.stale.storedGap
	}
	return model.Some(uint32(arrayPositionGap))
}

func (entry *indexEntry) analysisIsStale() bool {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.stale != nil
}

func (entry *indexEntry) holdsChangeWork() bool {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.pending != nil || entry.swap.change != nil || entry.swap.rebuild != nil
}

func (entry *indexEntry) rebalancing() *rebalanceRun {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.rebalance
}

func (entry *indexEntry) restoreInFlight() bool {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.restores > 0
}

func (entry *indexEntry) beginRestore() func() {
	entry.swap.mu.Lock()
	entry.swap.restores++
	run := entry.swap.change
	entry.swap.mu.Unlock()
	if run != nil {
		run.stop(entry.name)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			entry.swap.mu.Lock()
			entry.swap.restores--
			entry.swap.mu.Unlock()
		})
	}
}

func (entry *indexEntry) presence(ctx context.Context, ids []string) ([]bool, error) {
	pinned, unpin, err := entry.index().Pin(ctx)
	if err != nil {
		return nil, err
	}
	defer unpin()
	present := make([]bool, len(ids))
	for at, id := range ids {
		if present[at], err = entry.holds(pinned, id); err != nil {
			return nil, err
		}
	}
	return present, nil
}

func (entry *indexEntry) holds(ctx context.Context, id string) (bool, error) {
	if run := entry.rebalancing(); run != nil {
		if present, buffered := run.state(id); buffered {
			return present, nil
		}
	}
	return entry.index().Has(ctx, id)
}

func (entry *indexEntry) noteCleared() error {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.rebalance != nil {
		return rebalancingBackpressure(entry.name, `Index "`+entry.name+`" is currently being rebalanced`)
	}
	if entry.swap.log != nil {
		entry.swap.log.cleared = true
		clear(entry.swap.log.ids)
	}
	return nil
}
