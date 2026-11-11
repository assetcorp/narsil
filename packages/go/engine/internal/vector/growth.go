package vector

import (
	"context"
)

func (f *Field) growthPassLimit() int {
	return max(f.config.promotionThreshold, growthPassMaxVectors)
}

func (f *Field) growGraph(ctx context.Context, snapshot []string) error {
	f.writeMu.Lock()
	needsCalibration := f.quantises() && !f.calibrated()
	f.writeMu.Unlock()
	if needsCalibration {
		calibrated, err := f.calibrateBeforeBuild(ctx)
		if err != nil || !calibrated {
			return err
		}
	}
	admit := func(docID string) bool {
		if f.tombstones.has(docID) || !f.store.has(docID) {
			f.buffer.delete(f.store, docID)
			return false
		}
		return true
	}
	return f.growPrivately(ctx, snapshot, admit)
}

func (f *Field) growPrivately(ctx context.Context, docIDs []string, admit admitDocument) error {
	f.writeMu.Lock()
	source := f.graph
	if f.disposed || source == nil {
		f.writeMu.Unlock()
		return nil
	}
	private, err := source.clone()
	if err != nil {
		f.writeMu.Unlock()
		return err
	}
	f.fresh = private
	f.writeMu.Unlock()
	grown, completed, err := f.insertLocally(ctx, private, docIDs, admit)
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	f.fresh = nil
	if err != nil || !completed || f.disposed || f.graph == nil || f.graph.lineage != source.lineage {
		grown.resource.drop()
		return err
	}
	return f.adoptGrown(grown, docIDs)
}

func (f *Field) adoptGrown(grown *graphMemory, docIDs []string) error {
	shuffledBuildCount, hasShuffledBuild, compactedNodeCount := f.shuffledBuildCount, f.hasShuffledBuild, f.compactedNodeCount
	if err := f.adoptGraph(grown); err != nil {
		grown.resource.drop()
		return err
	}
	f.shuffledBuildCount, f.hasShuffledBuild, f.compactedNodeCount = shuffledBuildCount, hasShuffledBuild, compactedNodeCount
	f.revision.Add(1)
	f.leaveBufferOnceConnected(grown, docIDs)
	return nil
}
