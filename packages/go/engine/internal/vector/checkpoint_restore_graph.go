package vector

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

func (f *Field) releaseReplacedLocked() {
	for _, ordinal := range f.store.releaseReplacedVectors() {
		f.clearCodes(ordinal)
	}
}

func (f *Field) bufferEveryVectorOutsideTheGraph() {
	for _, docID := range f.liveDocIDs() {
		ordinal, held := f.store.ordinalOf(docID)
		if f.graph == nil || !held || !f.graph.holdsLiveNode(ordinal) {
			f.buffer.add(f.store, docID)
		}
	}
}

func (f *Field) insertNodesOfLaterGraph(later payload.NumberedGraphParts, ordinals []int32) error {
	for _, part := range later.Parts {
		if err := payload.RequireWholeNeighbourLists(part); err != nil {
			return err
		}
	}
	placed := 0
	for number, ordinal := range ordinals {
		if ordinal == noLiveVectorAtPosition || later.TopLayer(number) < 0 || !f.store.holdsDocument(ordinal) ||
			f.graph.holdsLiveNode(ordinal) {
			continue
		}
		graph, inserted, err := f.insertOrdinal(f.graph, ordinal, false)
		f.graph = graph
		if err != nil {
			return err
		}
		if inserted {
			placed++
		}
	}
	if placed == 0 {
		return nil
	}
	graph, err := f.connectUnreached(f.graph)
	f.graph = graph
	return err
}

func graphShapeOf(first payload.NumberedGraph) graphShape {
	metric, _ := nativeMetricOf(first.Metric)
	return graphShape{m: first.M, mMax0: first.M * 2, efConstruction: first.EfConstruction, metric: metric}
}

func (r *CheckpointRestore) loadedGraph(ordinalOfNumber []int32) (*graphMemory, error) {
	f := r.field
	graph, err := newGraphMemory(graphShapeOf(r.graph.Graphs[0].Parts[0]))
	if err != nil {
		return nil, err
	}
	if err := graph.deserializeNumbered(r.graph.Graphs[0], ordinalOfNumber); err != nil {
		graph.resource.drop()
		return nil, err
	}
	for ordinal := range r.tombstoned {
		if err := f.markTombstoneOrdinal(graph, ordinal); err != nil {
			graph.resource.drop()
			return nil, err
		}
	}
	return graph, nil
}

func (r *CheckpointRestore) restoreGraph(ordinalOfNumber []int32, calibrationLoaded bool) error {
	f := r.field
	if r.graph == nil || len(r.graph.Graphs) == 0 || len(r.graph.Graphs[0].Parts) == 0 {
		f.releaseReplacedLocked()
		f.bufferEveryVectorOutsideTheGraph()
		return nil
	}
	first := r.graph.Graphs[0].Parts[0]
	graph, err := r.loadedGraph(ordinalOfNumber)
	if err != nil {
		return err
	}
	if err := f.adoptGraph(graph); err != nil {
		graph.resource.drop()
		return err
	}
	if count, set := first.ShuffledBuildCount.Get(); set {
		f.shuffledBuildCount, f.hasShuffledBuild = int(count), true
		if calibrationLoaded {
			mean, known := first.CalibratedMeanLength.Get()
			f.adoptLoadedCalibration(int(count), mean, known)
		}
	}
	for _, later := range r.graph.Graphs[1:] {
		if err := f.insertNodesOfLaterGraph(later, ordinalOfNumber); err != nil {
			return err
		}
	}
	f.bufferEveryVectorOutsideTheGraph()
	if f.buffer.size() <= f.graph.size() {
		return nil
	}
	if err := f.adoptGraph(nil); err != nil {
		return err
	}
	f.releaseReplacedLocked()
	f.buffer.clear(f.store)
	f.bufferEveryVectorOutsideTheGraph()
	return nil
}

func (r *CheckpointRestore) numberEveryRestoredVector() []int32 {
	f := r.field
	total := 0
	for _, file := range r.files {
		total += len(file.ordinals)
	}
	ordinalOfNumber := make([]int32, 0, total)
	for _, file := range r.files {
		for position, ordinal := range file.ordinals {
			_, dead := r.tombstoned[ordinal]
			if !f.store.holdsDocument(ordinal) && !dead {
				file.ordinals[position] = noLiveVectorAtPosition
			}
		}
		ordinalOfNumber = append(ordinalOfNumber, file.ordinals...)
	}
	return ordinalOfNumber
}

func (r *CheckpointRestore) Finish() error {
	f := r.field
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !r.currentLocked() {
		return restoreEnded()
	}
	r.end()
	if f.disposed {
		return f.disposedError()
	}
	if err := r.finishLocked(); err != nil {
		if emptied := f.emptyFieldBeforeRestore(); emptied != nil {
			return emptied
		}
		return err
	}
	f.scheduleBuildLocked()
	return nil
}

func (r *CheckpointRestore) finishLocked() error {
	f := r.field
	if err := f.publish(f.store, f.graph); err != nil {
		return err
	}
	codesRestored := r.restoresCodes && r.codesAgree && r.sharedCodes != nil
	if r.restoresCodes && !codesRestored {
		if err := f.recalibrateFromStore(r.ctx); err != nil {
			return err
		}
		tombstoned := make([]int32, 0, len(r.tombstoned))
		for ordinal := range r.tombstoned {
			tombstoned = append(tombstoned, ordinal)
		}
		if err := f.writeCodesOf(tombstoned); err != nil {
			return err
		}
	}
	if err := r.restoreGraph(r.numberEveryRestoredVector(), codesRestored); err != nil {
		return err
	}
	current := f.signature()
	codedUnder := calibrationNeverCurrent
	if codesRestored && current.hasCalibration {
		codedUnder = current.calibration
	}
	f.savedFiles = make([]savedVectorFile, 0, len(r.files))
	for _, file := range r.files {
		saved := savedVectorFile{id: file.id, key: file.key, ordinals: file.ordinals}
		if file.coded {
			saved.calibration, saved.hasCalibration = codedUnder, true
		}
		f.savedFiles = append(f.savedFiles, saved)
	}
	signature := f.signature()
	f.savedSignature = &signature
	return f.publish(f.store, f.graph)
}
