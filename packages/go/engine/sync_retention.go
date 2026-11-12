package engine

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type syncRetainer struct {
	mu      sync.Mutex
	running map[string]bool
	again   map[string]bool
	stopped bool
	sweep   chan struct{}
	workers sync.WaitGroup
}

func (retainer *syncRetainer) schedule(n *Narsil, indexName string) {
	retainer.mu.Lock()
	defer retainer.mu.Unlock()
	if retainer.stopped {
		return
	}
	if retainer.running == nil {
		retainer.running, retainer.again = map[string]bool{}, map[string]bool{}
	}
	if retainer.sweep == nil {
		retainer.sweep = make(chan struct{})
		retainer.workers.Add(1)
		go retainer.sweepEvery(n, retainer.sweep)
	}
	if retainer.running[indexName] {
		retainer.again[indexName] = true
		return
	}
	retainer.running[indexName] = true
	retainer.workers.Add(1)
	go retainer.enforceUntilSettled(n, indexName)
}

func (retainer *syncRetainer) enforceUntilSettled(n *Narsil, indexName string) {
	defer retainer.workers.Done()
	for {
		retainer.mu.Lock()
		delete(retainer.again, indexName)
		retainer.mu.Unlock()
		if err := n.enforceSyncHistory(indexName); err != nil {
			n.emitDurabilityError(err)
		}
		retainer.mu.Lock()
		if !retainer.again[indexName] || retainer.stopped {
			delete(retainer.running, indexName)
			retainer.mu.Unlock()
			return
		}
		retainer.mu.Unlock()
	}
}

func (retainer *syncRetainer) sweepEvery(n *Narsil, stop chan struct{}) {
	defer retainer.workers.Done()
	ticker := time.NewTicker(syncHistorySweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			for _, entry := range n.sortedEntries() {
				if state := entry.sync.current(); state.keepsHistory() {
					retainer.schedule(n, entry.name)
				}
			}
		}
	}
}

func (retainer *syncRetainer) stop() {
	retainer.mu.Lock()
	retainer.stopped = true
	if retainer.sweep != nil {
		close(retainer.sweep)
		retainer.sweep = nil
	}
	retainer.mu.Unlock()
	retainer.workers.Wait()
}

func (n *Narsil) emitDurabilityError(err error) {
	n.events.emit(model.DurabilityErrorEvent{Err: err})
}

func (n *Narsil) enforceSyncHistory(indexName string) error {
	entry, _, release, err := n.acquireWithoutReopen(indexName)
	if err != nil {
		return nil
	}
	defer release()
	if entry == nil {
		return nil
	}
	state := entry.sync.current()
	if !state.keepsHistory() || entry.durable == nil {
		return nil
	}
	ctx := context.Background()
	var limits persist.HistoryLimits
	var publish func(context.Context) error
	if state.sync != nil && state.sync.active {
		syncLimits, err := syncHistoryLimits(ctx, entry, state.sync)
		if err != nil {
			return err
		}
		limits = syncLimits
		publish = func(ctx context.Context) error { return n.republishSyncSnapshot(ctx, entry) }
	}
	if state.changes != nil {
		changesLimits, err := changesHistoryLimits(ctx, entry, state.changes)
		if err != nil {
			return err
		}
		limits.MaxAgeMs = max(limits.MaxAgeMs, changesLimits.MaxAgeMs)
		limits.MaxBytes = max(limits.MaxBytes, changesLimits.MaxBytes)
	}
	_, err = entry.durable.EnforceSyncHistory(ctx, limits, publish, uint64(time.Now().UnixMilli()))
	return err
}

func (state *feedState) keepsHistory() bool {
	return state != nil && (state.changes != nil || (state.sync != nil && state.sync.active))
}

func syncHistoryLimits(ctx context.Context, entry *indexEntry, feature *syncFeature) (persist.HistoryLimits, error) {
	limits := persist.HistoryLimits{MaxAgeMs: uint64(feature.maxAgeMs.Or(defaultSyncHistoryMaxAgeMs)),
		MaxBytes: math.MaxUint64}
	if size, set := feature.maxBytes.Get(); set {
		limits.MaxBytes = uint64(size)
	} else if published, known, err := entry.durable.PublishedArchiveBytes(ctx); err != nil {
		return persist.HistoryLimits{}, err
	} else if known {
		limits.MaxBytes = published
	}
	return limits, nil
}

func changesHistoryLimits(ctx context.Context, entry *indexEntry, feature *changesFeature) (persist.HistoryLimits,
	error) {
	limits := persist.HistoryLimits{MaxAgeMs: uint64(feature.maxAgeMs.Or(defaultChangesHistoryMaxAgeMs))}
	if size, set := feature.maxBytes.Get(); set {
		limits.MaxBytes = uint64(size)
		return limits, nil
	}
	checkpointBytes, err := entry.durable.CheckpointBytes(ctx)
	if err != nil {
		return persist.HistoryLimits{}, err
	}
	limits.MaxBytes = max(checkpointBytes, minDefaultChangesHistoryBytes)
	return limits, nil
}

func (n *Narsil) republishSyncSnapshot(ctx context.Context, entry *indexEntry) error {
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	if feature := entry.sync.syncOn(); feature == nil || !feature.active {
		return narsilerr.New(narsilerr.CodeSyncNotEnabled, `Index "`+entry.name+`" has device sync off`,
			map[string]any{"indexName": entry.name})
	}
	configurationOf := func(listed manifest.Manifest) ([]byte, error) {
		if listed.AnalysisGeneration != entry.generation().Or(0) {
			return nil, narsilerr.New(narsilerr.CodeAnalysisChangeNotReady,
				`The analysis of index "`+entry.name+`" changed while the engine published its snapshot`,
				map[string]any{"indexName": entry.name})
		}
		configuration, err := entry.configuration()
		if err != nil {
			return nil, err
		}
		return indexconfig.Write(configuration, false)
	}
	var lastErr error
	for range maxSyncPublishAttempts {
		_, err := entry.durable.PublishSync(ctx, configurationOf)
		if narsilerr.CodeOf(err) != narsilerr.CodeAnalysisChangeNotReady {
			return err
		}
		lastErr = err
	}
	return lastErr
}
