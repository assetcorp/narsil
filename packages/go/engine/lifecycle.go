package engine

import (
	"context"
	"runtime"
	"runtime/debug"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

// DropIndex deletes the index called name with every document that it holds
// and, with durability configured, its saved files. The call waits for the
// reads and writes already running on the index, and every later call on the
// name returns CodeIndexNotFound until an index of that name is created
// again.
func (n *Narsil) DropIndex(ctx context.Context, name string) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	dropped, err := n.dropUnannounced(ctx, name)
	if err != nil {
		return err
	}
	return n.plugins.index(ctx, hookOnIndexDrop, &model.IndexContext{IndexName: name, Config: dropped})
}

func (n *Narsil) dropUnannounced(ctx context.Context, name string) (model.IndexConfig, error) {
	unlock := n.names.lock(name)
	defer unlock()
	slot, entry := n.slotOf(name)
	if entry == nil {
		if slot == nil {
			return model.IndexConfig{}, indexNotFound(name)
		}
		return n.dropClosed(ctx, name, slot)
	}
	if err := n.dropSuggestionIndexesOf(ctx, name); err != nil {
		return model.IndexConfig{}, err
	}
	entry.useMu.Lock()
	if entry.durable != nil {
		if err := entry.durable.Drop(ctx); err != nil {
			entry.useMu.Unlock()
			return model.IndexConfig{}, err
		}
	}
	entry.retired = true
	n.uninstall(entry)
	n.forgetSlot(name, slot)
	entry.useMu.Unlock()
	entry.dispose()
	n.workers.forget(name)
	n.afterSuggestionsDrop(ctx, name)
	return entry.currentConfig(), nil
}

func (n *Narsil) dropClosed(ctx context.Context, name string, slot *indexSlot) (model.IndexConfig, error) {
	summary, _ := slot.closedView()
	if err := n.dropSuggestionIndexesOf(ctx, name); err != nil {
		return model.IndexConfig{}, err
	}
	if n.manager != nil {
		if err := n.manager.RemoveClosedIndex(ctx, name); err != nil {
			return model.IndexConfig{}, err
		}
	}
	n.forgetSlot(name, slot)
	n.workers.forget(name)
	n.afterSuggestionsDrop(ctx, name)
	return summary.config, nil
}

func (n *Narsil) sortedSlots() []*indexSlot {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	return valuesInNameOrder(n.slots)
}

func (n *Narsil) infoOf(slot *indexSlot) model.IndexInfo {
	info := model.IndexInfo{Name: slot.name, State: slot.publicState(), ReopenCount: slot.reopens()}
	if _, entry := n.slotOf(slot.name); entry != nil {
		info.DocumentCount = entry.index().Count()
		info.PartitionCount = entry.index().PartitionCount()
		info.Language = entry.currentAnalysis().language
		info.AnalysisStale = entry.analysisIsStale()
		return info
	}
	summary, _ := slot.closedView()
	info.DocumentCount = summary.documentCount
	info.PartitionCount = summary.partitionCount
	info.Language = summary.language
	return info
}

// ListIndexes returns one summary per index, ordered by name, closed indexes
// included. For a closed index the counts are the ones that it held when it
// closed, and State reports whether it is open, closed, or failed to reopen.
// It returns an empty list after Shutdown.
func (n *Narsil) ListIndexes() []IndexInfo {
	leave, err := n.enter()
	if err != nil {
		return []model.IndexInfo{}
	}
	defer leave()
	slots := n.sortedSlots()
	infos := make([]model.IndexInfo, 0, len(slots))
	for _, slot := range slots {
		infos = append(infos, n.infoOf(slot))
	}
	return infos
}

func (n *Narsil) acquireWithoutReopen(name string) (*indexEntry, *indexSlot, func(), error) {
	leave, err := n.enter()
	if err != nil {
		return nil, nil, nil, err
	}
	for {
		slot, entry := n.slotOf(name)
		if entry == nil {
			if slot == nil {
				leave()
				return nil, nil, nil, indexNotFound(name)
			}
			return nil, slot, leave, nil
		}
		entry.useMu.RLock()
		if !entry.retired {
			return entry, slot, func() {
				entry.useMu.RUnlock()
				leave()
			}, nil
		}
		entry.useMu.RUnlock()
		runtime.Gosched()
	}
}

func (entry *indexEntry) estimatedBytes() (int64, error) {
	total, err := entry.index().EstimateMemoryBytes()
	if err != nil {
		return 0, err
	}
	for _, path := range entry.vectorPaths {
		total += int64(entry.handle.Vectors[path].EstimateMemoryBytes())
	}
	return total, nil
}

// GetStats returns the document count, partition count, memory estimate,
// language, and schema of the index called indexName, or CodeIndexNotFound.
// It leaves a closed index closed and reports the counts that the index held
// when it closed, with a memory estimate of 0.
func (n *Narsil) GetStats(indexName string) (IndexStats, error) {
	entry, slot, release, err := n.acquireWithoutReopen(indexName)
	if err != nil {
		return model.IndexStats{}, err
	}
	defer release()
	if entry == nil {
		summary, _ := slot.closedView()
		return model.IndexStats{DocumentCount: summary.documentCount, PartitionCount: summary.partitionCount,
			Language: summary.language, Schema: summary.schema}, nil
	}
	estimated, err := entry.estimatedBytes()
	if err != nil {
		return model.IndexStats{}, err
	}
	return model.IndexStats{
		DocumentCount:        entry.index().Count(),
		PartitionCount:       entry.index().PartitionCount(),
		EstimatedMemoryBytes: estimated,
		Language:             entry.currentAnalysis().language,
		Schema:               entry.parsed.Schema(),
	}, nil
}

// GetPartitionStats returns the document count and memory estimate of each
// partition of the index called indexName, in partition order. It returns an
// empty list for a closed index and leaves the index closed.
func (n *Narsil) GetPartitionStats(indexName string) ([]PartitionStatsResult, error) {
	entry, _, release, err := n.acquireWithoutReopen(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	if entry == nil {
		return []model.PartitionStatsResult{}, nil
	}
	return entry.index().PartitionStats()
}

func processMemory() *model.ProcessMemoryReport {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	report := &model.ProcessMemoryReport{
		HeapUsed:  int64(stats.HeapAlloc),
		HeapTotal: int64(stats.HeapSys),
		External:  int64(stats.Sys - stats.HeapSys),
		RSS:       int64(stats.Sys),
	}
	if limit := debug.SetMemoryLimit(-1); limit > 0 && limit < int64(^uint64(0)>>1) {
		report.HeapLimit = model.Some(limit)
	}
	return report
}

// GetMemoryStats returns what the engine and the Go process use: the heap
// figures of the process, the summed memory estimate of every index, which
// indexes serve their queries from the worker pool, and which checkpoints
// the engine is holding back.
func (n *Narsil) GetMemoryStats(ctx context.Context) (MemoryStats, error) {
	leave, err := n.enter()
	if err != nil {
		return model.MemoryStats{}, err
	}
	defer leave()
	if err := ctx.Err(); err != nil {
		return model.MemoryStats{}, err
	}
	stats := model.MemoryStats{Process: processMemory(), WorkerCopies: []model.WorkerCopyReport{},
		HeldCheckpoints: []model.HeldCheckpointReport{}, Workers: n.workers.memoryReports()}
	for _, entry := range n.sortedEntries() {
		estimated, err := entry.estimatedBytes()
		if err != nil {
			return model.MemoryStats{}, err
		}
		stats.EstimatedIndexBytes += estimated
		stats.WorkerCopies = append(stats.WorkerCopies, model.WorkerCopyReport{IndexName: entry.name,
			ScaledOut: entry.promoted.Load()})
	}
	for _, slot := range n.sortedSlots() {
		if slot.publicState() == model.IndexOpen {
			stats.OpenIndexCount++
		} else {
			stats.ClosedIndexCount++
		}
		stats.ReopenCount += slot.reopens()
	}
	if n.manager != nil {
		for _, held := range n.manager.HeldCheckpoints() {
			stats.HeldCheckpoints = append(stats.HeldCheckpoints, model.HeldCheckpointReport{IndexName: held.IndexName,
				PartitionIDs: held.PartitionIDs, RecordsSinceCheckpoint: held.RecordsSinceCheckpoint,
				DocumentBytesSinceCheckpoint: held.DocumentBytesSinceCheckpoint})
		}
	}
	return stats, nil
}
