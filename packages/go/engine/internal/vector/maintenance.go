package vector

import (
	"context"
	"math"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (f *Field) Compact() error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.cold != nil || f.disposed {
		return nil
	}
	f.revision.Add(1)
	return f.compactLocked()
}

func (f *Field) compactLocked() error {
	if f.disposed || (f.tombstones.size() == 0 && len(f.store.replaced) == 0) {
		return nil
	}
	f.writer.pinNow()
	defer f.writer.unpin()
	if f.graph != nil {
		before := f.graph.tombstoneCount()
		compacted, err := f.compactGraph(f.graph)
		if err != nil {
			return err
		}
		f.compactedNodeCount += max(0, before-compacted.tombstoneCount())
		f.graph = compacted
	}
	if f.fresh != nil {
		if _, err := f.compactGraph(f.fresh); err != nil {
			return err
		}
	}
	oldest := f.slots.oldestPin()
	for _, docID := range f.tombstones.values() {
		ordinal, held := f.store.ordinalOf(docID)
		if held && (!f.store.freeable(ordinal, oldest) || f.graphsHoldNode(ordinal)) {
			continue
		}
		f.store.remove(docID)
		f.buffer.delete(f.store, docID)
		f.tombstones.delete(f.store, docID)
	}
	for _, ordinal := range f.store.releaseFreeableReplaced(oldest, f.graphsHoldNode) {
		f.clearCodes(ordinal)
	}
	return nil
}

func (f *Field) graphsHoldNode(ordinal int32) bool {
	return (f.graph != nil && f.graph.holdsNode(ordinal)) || (f.fresh != nil && f.fresh.holdsNode(ordinal))
}

func (f *Field) foldIntoGraph(ctx context.Context) error {
	f.writeMu.Lock()
	rebuildNeeded := f.graphNeedsRebuild()
	if err := f.compactLocked(); err != nil {
		f.writeMu.Unlock()
		return err
	}
	if f.liveSize() == 0 {
		defer f.writeMu.Unlock()
		if err := f.adoptGraph(nil); err != nil {
			return err
		}
		f.buffer.clear(f.store)
		f.clearQuantizer()
		return nil
	}
	graph := f.graph
	unshuffled := !f.hasShuffledBuild
	live := f.liveSize()
	f.writeMu.Unlock()
	if graph == nil || rebuildNeeded || unshuffled {
		calibrated, err := f.calibrateBeforeBuild(ctx)
		if err != nil || !calibrated {
			return err
		}
		_, err = f.buildGraphFromStore(ctx)
		return err
	}
	drifted, err := f.recalibrateWhenDrifted(ctx, live)
	if err != nil {
		return err
	}
	if drifted {
		_, err = f.buildGraphFromStore(ctx)
		return err
	}
	return f.insertMissing(ctx, graph)
}

func (f *Field) insertMissing(ctx context.Context, graph *graphMemory) error {
	f.writeMu.Lock()
	held := f.liveDocIDs()
	lineage := graph.lineage
	f.writeMu.Unlock()
	stillUnplaced := func(docID string) bool {
		if f.tombstones.has(docID) {
			return false
		}
		current := f.graph
		if current == nil || current.lineage != lineage {
			return true
		}
		ordinal, known := f.store.ordinalOf(docID)
		return !known || !current.holdsLiveNode(ordinal) || f.buffer.has(docID)
	}
	if _, _, err := f.insertLocally(ctx, graph, held, stillUnplaced); err != nil {
		return err
	}
	return f.shuffledRebuildWhenDue(ctx)
}

func (f *Field) Optimize(ctx context.Context) error {
	if err := f.untilColdLoaded(ctx); err != nil {
		return err
	}
	if err := f.beginExclusiveBuild(ctx); err != nil {
		return err
	}
	f.revision.Add(1)
	err := f.foldIntoGraph(ctx)
	f.endExclusiveBuild(err)
	return err
}

func (f *Field) fillGraph(ctx context.Context) error {
	f.writeMu.Lock()
	graph := f.graph
	live := f.liveSize()
	needsCalibration := f.quantises() && !f.calibrated()
	rebuild := graph != nil && !f.builds.rebuilding && f.graphNeedsRebuild()
	f.writeMu.Unlock()
	if graph == nil {
		if live >= f.config.promotionThreshold {
			return f.promoteToGraph(ctx)
		}
		return nil
	}
	if needsCalibration {
		calibrated, err := f.calibrateBeforeBuild(ctx)
		if err != nil || !calibrated {
			return err
		}
	}
	if rebuild {
		_, err := f.buildGraphFromStore(ctx)
		return err
	}
	return f.insertMissing(ctx, graph)
}

func (f *Field) CompleteGraph(ctx context.Context) error {
	if err := f.untilColdLoaded(ctx); err != nil {
		return err
	}
	if err := f.beginExclusiveBuild(ctx); err != nil {
		return err
	}
	err := f.fillGraph(ctx)
	f.endExclusiveBuild(err)
	return err
}

func durationOf(count int, millisecondsPerItem float64, scale float64) time.Duration {
	milliseconds := math.Round(float64(float64(count)*millisecondsPerItem) * scale)
	return time.Duration(milliseconds) * time.Millisecond
}

func (f *Field) bufferedOutsideGraph() int {
	if f.graph == nil {
		return f.buffer.size()
	}
	outside := 0
	for _, docID := range f.buffer.values() {
		ordinal, held := f.store.ordinalOf(docID)
		if !held || !f.graph.holdsLiveNode(ordinal) {
			outside++
		}
	}
	return outside
}

func (f *Field) MaintenanceStatus() model.VectorMaintenanceResult {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	storeSize := f.store.size()
	graphNodes := storeSize
	if f.graph != nil {
		graphNodes = f.graph.size() + f.graph.tombstoneCount()
	}
	tombstoned := f.tombstones.size() + len(f.store.replaced)
	ratio := 0.0
	if graphNodes > 0 {
		ratio = float64(tombstoned) / float64(graphNodes)
	}
	rebuilds := f.graph == nil || f.graphNeedsRebuild() || f.shuffledRebuildDue(f.liveSize())
	outsideGraph := f.bufferedOutsideGraph()
	optimizeCount := outsideGraph
	if rebuilds {
		optimizeCount = storeSize
	}
	graphCount := 0
	if f.graph != nil || f.cold != nil {
		graphCount = 1
	}
	return model.VectorMaintenanceResult{
		FieldName:         f.config.fieldName,
		TombstoneRatio:    ratio,
		GraphCount:        graphCount,
		BufferSize:        outsideGraph,
		Building:          f.builds.running || f.builds.retry != nil,
		WaitingForMemory:  f.builds.waitingForMemory,
		EstimatedCompact:  durationOf(tombstoned, estimatedCompactPerTombstone, f.config.dimensionScale),
		EstimatedOptimize: durationOf(optimizeCount, estimatedOptimizePerVector, f.config.dimensionScale),
		LoadingFromFiles:  f.cold != nil,
	}
}
