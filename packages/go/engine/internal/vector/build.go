package vector

import (
	"context"
)

type admitDocument func(docID string) bool

func admitEvery(string) bool { return true }

func (f *Field) placeChunk(graph *graphMemory, docIDs []string, admit admitDocument) (*graphMemory, int, bool, error) {
	placed := 0
	for _, docID := range docIDs {
		if f.disposed {
			return graph, placed, false, nil
		}
		if !admit(docID) {
			continue
		}
		ordinal, held := f.store.ordinalOf(docID)
		if !held {
			continue
		}
		next, inserted, err := f.insertOrdinal(graph, ordinal, false)
		graph = next
		if err != nil {
			return graph, placed, false, err
		}
		if graph == f.graph {
			f.buffer.delete(f.store, docID)
			f.builds.connectPending = f.builds.connectPending || inserted
		}
		placed++
	}
	return graph, placed, true, nil
}

func (f *Field) currentOfLineage(graph *graphMemory, published bool) (*graphMemory, bool) {
	if !published {
		return graph, true
	}
	if f.graph == nil || f.graph.lineage != graph.lineage {
		return graph, false
	}
	return f.graph, true
}

func (f *Field) insertLocally(ctx context.Context, graph *graphMemory, docIDs []string,
	admit admitDocument) (*graphMemory, bool, error) {
	f.writeMu.Lock()
	published := graph == f.graph
	f.writeMu.Unlock()
	placed := 0
	for start := range docIDs {
		if err := ctx.Err(); err != nil {
			return graph, false, err
		}
		chunk := docIDs[start : start+1]
		f.writeMu.Lock()
		target, current := f.currentOfLineage(graph, published)
		if !current {
			f.writeMu.Unlock()
			return graph, false, nil
		}
		next, count, open, err := f.placeChunk(target, chunk, admit)
		graph = next
		placed += count
		if count > 0 {
			f.revision.Add(1)
		}
		f.writeMu.Unlock()
		if err != nil || !open {
			return graph, false, err
		}
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return graph, false, nil
	}
	if placed == 0 {
		return graph, true, nil
	}
	graph, current := f.currentOfLineage(graph, published)
	if !current {
		return graph, false, nil
	}
	connected, err := f.connectUnreached(graph)
	if err != nil {
		return connected, false, err
	}
	f.revision.Add(1)
	if published {
		f.builds.connectPending = false
	}
	return connected, true, nil
}

func (f *Field) connectBeforeCopying() error {
	if !f.builds.connectPending {
		return nil
	}
	if f.graph != nil {
		if _, err := f.connectUnreached(f.graph); err != nil {
			return err
		}
		f.revision.Add(1)
	}
	f.builds.connectPending = false
	return nil
}

func (f *Field) promoteToGraph(ctx context.Context) error {
	f.writeMu.Lock()
	empty := f.liveSize() == 0
	f.writeMu.Unlock()
	if empty {
		return nil
	}
	calibrated, err := f.calibrateBeforeBuild(ctx)
	if err != nil || !calibrated {
		return err
	}
	_, err = f.buildGraphFromStore(ctx)
	return err
}

func (f *Field) startFreshGraph() (*graphMemory, *graphMemory, []string, error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return nil, nil, nil, nil
	}
	order := f.liveDocIDs()
	shuffleInPlace(order)
	graph, err := newGraphMemory(f.config.shape, f.slots)
	if err != nil {
		return nil, nil, nil, err
	}
	f.fresh = graph
	return f.graph, graph, order, nil
}

func (f *Field) buildGraphFromStore(ctx context.Context) (bool, error) {
	previous, graph, order, err := f.startFreshGraph()
	if err != nil || graph == nil {
		return false, err
	}
	built, completed, err := f.insertLocally(ctx, graph, order, admitEvery)
	f.writeMu.Lock()
	f.fresh = nil
	if err != nil || !completed || f.graph != previous || f.disposed {
		f.writeMu.Unlock()
		built.resource.drop()
		return false, err
	}
	f.keepPlacedVisibleToEarlierSearches(previous, built)
	if err := f.adoptGraph(built); err != nil {
		f.writeMu.Unlock()
		return false, err
	}
	f.shuffledBuildCount = built.size()
	f.hasShuffledBuild = true
	f.revision.Add(1)
	f.bufferWhatTheGraphLacks(built)
	f.writeMu.Unlock()
	return true, f.releasePendingLocations(ctx)
}

func (f *Field) keepPlacedVisibleToEarlierSearches(previous, built *graphMemory) {
	if previous == nil {
		return
	}
	placed := []int32{}
	f.store.table.eachUnplaced(func(ordinal int32) bool {
		if built.holdsNode(ordinal) {
			placed = append(placed, ordinal)
		}
		return true
	})
	if len(placed) > 0 {
		previous.lineage.alsoScan.Store(&placed)
	}
}

func (f *Field) scanRetiredOutsideOf(graph *graphMemory) {
	oldest := min(f.slots.oldestPin(), f.slots.Sequence())
	keep := func(ordinal int32) {
		if !graph.holdsNode(ordinal) && f.store.holdsVector(ordinal) && !f.store.freeable(ordinal, oldest) {
			f.store.keepScanning(ordinal)
		}
	}
	for _, docID := range f.tombstones.values() {
		if ordinal, held := f.store.ordinalOf(docID); held {
			keep(ordinal)
		}
	}
	for ordinal := range f.store.replaced {
		keep(ordinal)
	}
}

func (f *Field) adoptGraph(graph *graphMemory) error {
	previous := f.graph
	if graph != nil {
		for _, docID := range f.tombstones.values() {
			ordinal, held := f.store.ordinalOf(docID)
			if held && graph.holdsLiveNode(ordinal) {
				if err := f.markTombstoneOrdinal(graph, ordinal); err != nil {
					return err
				}
			}
		}
		f.scanRetiredOutsideOf(graph)
	}
	if err := f.publish(f.store, graph); err != nil {
		return err
	}
	f.graph = graph
	f.shuffledBuildCount = 0
	f.hasShuffledBuild = false
	f.compactedNodeCount = 0
	if previous != nil && previous != graph {
		previous.resource.drop()
	}
	return nil
}

func (f *Field) bufferWhatTheGraphLacks(graph *graphMemory) {
	for _, docID := range f.liveDocIDs() {
		ordinal, held := f.store.ordinalOf(docID)
		if held && graph.holdsLiveNode(ordinal) {
			f.buffer.delete(f.store, docID)
			continue
		}
		f.buffer.add(f.store, docID)
	}
}

func (f *Field) growGraph(ctx context.Context, graph *graphMemory, snapshot []string) error {
	f.writeMu.Lock()
	needsCalibration := f.quantises() && !f.calibrated()
	f.writeMu.Unlock()
	if needsCalibration {
		calibrated, err := f.calibrateBeforeBuild(ctx)
		if err != nil || !calibrated {
			return err
		}
	}
	lineage := graph.lineage
	admit := func(docID string) bool {
		if f.graph == nil || f.graph.lineage != lineage {
			return false
		}
		if f.tombstones.has(docID) || !f.store.has(docID) {
			f.buffer.delete(f.store, docID)
			return false
		}
		return true
	}
	_, _, err := f.insertLocally(ctx, graph, snapshot, admit)
	return err
}
