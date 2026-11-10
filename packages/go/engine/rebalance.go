package engine

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const hookOnPartitionSplit hookName = "onPartitionSplit"

func validateRebalanceTarget(config model.IndexConfig, target int) error {
	if target <= 0 {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"Target partition count must be a positive integer, got "+strconv.Itoa(target),
			map[string]any{"targetPartitionCount": target})
	}
	if maximum := config.Partitions.MaxPartitions.Or(schema.DefaultMaxPartitions); target > maximum {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"Target partition count ("+strconv.Itoa(target)+") is above the maximum of "+strconv.Itoa(maximum)+" partitions",
			map[string]any{"targetPartitionCount": target, "maxPartitions": maximum})
	}
	return nil
}

func (entry *indexEntry) startRebalance(target int) (*rebalanceRun, error) {
	entry.writeMu.Lock()
	defer entry.writeMu.Unlock()
	run := &rebalanceRun{target: target, states: map[string]bool{}, replayed: make(chan struct{})}
	if entry.durable != nil {
		run.buffered = entry.durable.BeginBufferedLog()
	}
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.rebalance != nil {
		return nil, narsilerr.New(narsilerr.CodePartitionRebalancingBackpressure,
			`Index "`+entry.name+`" is already being rebalanced`, nil)
	}
	if entry.swap.pending != nil || entry.swap.change != nil || entry.swap.rebuild != nil {
		return nil, rebalancingBackpressure(entry.name,
			`Index "`+entry.name+`" is changing its analysis settings, so try the rebalance again once the change ends`)
	}
	if target == entry.index().PartitionCount() {
		return nil, nil
	}
	entry.swap.rebalance = run
	return run, nil
}

func (entry *indexEntry) finishRebalanceLocked(run *rebalanceRun) {
	entry.swap.mu.Lock()
	if entry.swap.rebalance == run {
		entry.swap.rebalance = nil
	}
	entry.swap.mu.Unlock()
	close(run.replayed)
}

func (entry *indexEntry) abandonRebalance(run *rebalanceRun) {
	entry.writeMu.Lock()
	defer entry.writeMu.Unlock()
	entry.replayInto(entry.index(), run.take())
	if run.buffered != nil {
		run.buffered.Settle()
	}
	entry.finishRebalanceLocked(run)
}

func (n *Narsil) proceedFor(ctx context.Context, entry *indexEntry, operation string) func() error {
	return func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if n.stopping.Err() != nil {
			return engineShutDown()
		}
		entry.useMu.RLock()
		retired := entry.retired
		entry.useMu.RUnlock()
		if retired || entry.restoreInFlight() {
			return narsilerr.New(narsilerr.CodeIndexNotFound, `Index "`+entry.name+`" closed during its `+operation,
				map[string]any{"indexName": entry.name})
		}
		return nil
	}
}

func (entry *indexEntry) swapLayout(ctx context.Context, run *rebalanceRun, built *index.Index, settings index.Settings,
	proceed func() error) error {
	entry.writeMu.Lock()
	defer entry.writeMu.Unlock()
	previous := entry.index()
	install := func() (persist.IndexSwap, bool, error) {
		if err := proceed(); err != nil {
			return persist.IndexSwap{}, false, err
		}
		built.SetSynonyms(previous.Synonyms())
		built.SetBM25(previous.BM25())
		queued := run.take()
		entry.replayInto(built, queued)
		entry.swap.current.Store(built)
		entry.finishRebalanceLocked(run)
		return persist.IndexSwap{Index: built, NewDetachedIndex: detachedBuilder(settings, built), Buffered: run.buffered,
			MetadataFirst: run.target > previous.PartitionCount(),
			Committed:     func(listed manifest.Manifest) bool { return len(listed.Partitions) == run.target },
			Revert: func(*index.Index) {
				entry.swap.current.Store(previous)
				entry.replayInto(previous, queued)
				run.buffered.Settle()
			}}, true, nil
	}
	err := entry.installTerms(ctx, install)
	if entry.rebalancing() == run {
		entry.replayInto(previous, run.take())
		if run.buffered != nil {
			run.buffered.Settle()
		}
		entry.finishRebalanceLocked(run)
	}
	return err
}

// Rebalance redistributes the documents of the index called indexName across
// targetPartitionCount partitions. Reads keep answering from the old
// partitions while the engine copies the documents, and writes that arrive in
// the meantime wait in a queue of at most 10,000 entries, which the engine
// logs before it acknowledges each write and applies before the new
// partitions answer. The call returns CodePartitionCapacityExceeded for a
// count below 1 or above maxPartitions, and CodePartitionRebalancingBackpressure
// when the index is already rebalancing or is changing its analysis. A count
// equal to the current one returns at once.
func (n *Narsil) Rebalance(ctx context.Context, indexName string, targetPartitionCount int) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	defer n.emitWrite(indexName)
	if err := validateRebalanceTarget(entry.currentConfig(), targetPartitionCount); err != nil {
		return err
	}
	releaseEpoch, err := n.holdRenewedSyncEpoch(ctx, entry)
	if err != nil {
		return err
	}
	defer releaseEpoch()
	run, err := entry.startRebalance(targetPartitionCount)
	if err != nil || run == nil {
		return err
	}
	entry.maintenance.Add(1)
	defer entry.maintenance.Add(-1)
	oldCount := entry.index().PartitionCount()
	proceed := n.proceedFor(ctx, entry, "rebalance")
	entry.writeMu.Lock()
	settings := entry.settingsFor(entry.currentAnalyzer(), targetPartitionCount)
	entry.writeMu.Unlock()
	built, err := index.New(settings)
	if err == nil {
		err = copyDocuments(entry.handle, entry.index(), built, proceed, func(int) {})
	}
	if err != nil {
		entry.abandonRebalance(run)
		return err
	}
	err = entry.swapLayout(ctx, run, built, settings, proceed)
	if entry.index() == built {
		n.announceRebalance(ctx, entry, oldCount, targetPartitionCount)
	}
	return err
}

func (n *Narsil) announceRebalance(ctx context.Context, entry *indexEntry, oldCount int, newCount int) {
	n.events.emit(model.PartitionRebalanceEvent{IndexName: entry.name, OldCount: oldCount, NewCount: newCount})
	partition := &model.PartitionContext{IndexName: entry.name, OldPartitionCount: oldCount, NewPartitionCount: newCount}
	_ = n.plugins.each(ctx, hookOnPartitionSplit, func(plugin model.Plugin) func(context.Context) error {
		if plugin.OnPartitionSplit == nil {
			return nil
		}
		return func(ctx context.Context) error { return plugin.OnPartitionSplit(ctx, partition) }
	})
	n.checkWatermark(entry)
}

// UpdatePartitionConfig changes the capacity limits of the index called
// indexName: each set field of partitions replaces the current value and each
// unset field keeps it. The engine checks the values as CreateIndex does, and
// returns CodePartitionCapacityExceeded when maxPartitions falls below the
// current partition count or the new capacity falls below the document count,
// and CodePartitionRebalancingBackpressure while the index rebalances. With
// durability configured, the engine writes the index metadata that holds the
// new limits before it returns.
func (n *Narsil) UpdatePartitionConfig(ctx context.Context, indexName string, partitions PartitionConfig) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return err
	}
	entry.writeMu.Lock()
	err = n.updatePartitionConfigLocked(ctx, entry, partitions)
	entry.writeMu.Unlock()
	if err == nil {
		n.checkWatermark(entry)
	}
	return err
}

func (n *Narsil) updatePartitionConfigLocked(ctx context.Context, entry *indexEntry, partitions model.PartitionConfig) error {
	if entry.rebalancing() != nil {
		return narsilerr.New(narsilerr.CodePartitionRebalancingBackpressure,
			`Index "`+entry.name+`" is currently being rebalanced`, nil)
	}
	if err := schema.ValidatePartitionConfig(partitions); err != nil {
		return err
	}
	count := entry.index().PartitionCount()
	if maximum, set := partitions.MaxPartitions.Get(); set && maximum < count {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"maxPartitions ("+strconv.Itoa(maximum)+") is less than the current partition count ("+strconv.Itoa(count)+")",
			map[string]any{"maxPartitions": maximum, "partitionCount": count})
	}
	current := entry.currentConfig().Partitions
	documents := entry.index().Count()
	perPartition, capped := partitions.MaxDocsPerPartition.Get()
	if !capped {
		perPartition, capped = current.MaxDocsPerPartition.Get()
	}
	if capped && perPartition*count < documents {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"New capacity ("+strconv.Itoa(perPartition*count)+") is less than current document count ("+strconv.Itoa(documents)+")",
			map[string]any{"newTotalCapacity": perPartition * count, "currentDocCount": documents})
	}
	merged := current
	if partitions.MaxDocsPerPartition.IsSet() {
		merged.MaxDocsPerPartition = partitions.MaxDocsPerPartition
	}
	if partitions.MaxPartitions.IsSet() {
		merged.MaxPartitions = partitions.MaxPartitions
	}
	if partitions.Watermark.IsSet() {
		merged.Watermark = partitions.Watermark
	}
	entry.settingsMu.Lock()
	entry.config.Partitions = merged
	entry.settingsMu.Unlock()
	if entry.durable == nil {
		return nil
	}
	if err := entry.durable.PersistMetadata(ctx); err != nil {
		entry.settingsMu.Lock()
		entry.config.Partitions = current
		entry.settingsMu.Unlock()
		return err
	}
	return nil
}
