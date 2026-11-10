package vector

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type CheckpointPlanRequest struct {
	ListedKeys         []string
	Listed             bool
	RewritesGraph      bool
	PinsRetiredVectors bool
}

type NewVectorFile struct {
	Payload    payload.VectorFile
	Ordinals   []int32
	Dead       []byte
	Magnitudes []float64
}

type plannedVector struct {
	ordinal    int32
	docID      string
	tombstoned bool
}

type CheckpointPlan struct {
	field              *Field
	store              *storeMemory
	unchanged          bool
	kept               []KeptVectorFile
	keptFiles          []savedVectorFile
	newFiles           int
	capacity           int
	planned            []plannedVector
	centroid           []float64
	firstWrittenNumber int
	signature          fieldSignature
	storesHeads        bool
	pinsRetired        bool

	mu           sync.Mutex
	stillPinned  bool
	graphParts   []payload.GraphPart
	partsToWrite []payload.GraphPart
	vanished     map[int]struct{}
	strippedFor  int
}

func (f *Field) PlanCheckpoint(ctx context.Context, request CheckpointPlanRequest) (*CheckpointPlan, error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return nil, f.disposedError()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	signature := f.signature()
	trusted := f.registryMatches(request.ListedKeys)
	capacity := VectorsPerFile(f.config.dimension, f.config.bits)
	listed := []savedVectorFile{}
	if trusted {
		listed = f.savedFiles
	}
	keptFiles, carriedCounts := f.filesWorthKeeping(listed, signature)
	keptFiles, _ = absorbSmallerPartialFiles(keptFiles, carriedCounts, f.countOutside(carriedCounts), capacity)
	written := f.ordinalsOutsideOf(keptFiles)
	unchanged := !request.RewritesGraph && trusted && request.Listed && sameSignature(f.savedSignature, signature) &&
		len(written) == 0
	plan := &CheckpointPlan{
		field:       f,
		store:       f.store,
		unchanged:   unchanged,
		keptFiles:   keptFiles,
		newFiles:    (len(written) + capacity - 1) / capacity,
		capacity:    capacity,
		planned:     make([]plannedVector, len(written)),
		centroid:    f.codedCentroid(),
		signature:   signature,
		storesHeads: f.readsFromDisk(),
		pinsRetired: request.PinsRetiredVectors,
		stillPinned: request.PinsRetiredVectors,
		vanished:    map[int]struct{}{},
	}
	for index, ordinal := range written {
		docID, held := f.store.docIDOf(ordinal)
		if !held {
			docID = f.store.table.storedDocID(ordinal)
		}
		plan.planned[index] = plannedVector{ordinal: ordinal, docID: docID, tombstoned: !f.isLive(ordinal)}
	}
	for _, file := range keptFiles {
		plan.firstWrittenNumber += len(file.ordinals)
		plan.kept = append(plan.kept, KeptVectorFile{
			ID: file.id, Key: file.key, Count: len(file.ordinals),
			Dead: deadBitsWhere(len(file.ordinals), func(position int) bool { return !f.isLive(file.ordinals[position]) }),
		})
	}
	if !unchanged {
		numberOfOrdinal, ordinalOfNumber := f.numberEveryVector(keptFiles, written)
		parts, err := f.graphPartsOf(ctx, numberOfOrdinal, ordinalOfNumber)
		if err != nil {
			return nil, err
		}
		plan.graphParts, plan.partsToWrite = parts, parts
	}
	if request.PinsRetiredVectors {
		f.store.pins.pin()
	}
	return plan, nil
}

func (p *CheckpointPlan) Unchanged() bool {
	return p.unchanged
}

func (p *CheckpointPlan) Kept() []KeptVectorFile {
	return p.kept
}

func (p *CheckpointPlan) NewFiles() int {
	return p.newFiles
}

func (p *CheckpointPlan) StoresHeads() bool {
	return p.storesHeads
}

func (p *CheckpointPlan) GraphParts() []payload.GraphPart {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.graphParts == nil || len(p.vanished) == p.strippedFor {
		return p.partsToWrite
	}
	stripped := make([]payload.GraphPart, len(p.graphParts))
	for index, part := range p.graphParts {
		graphs := make([]payload.NumberedGraph, len(part.Graphs))
		for at, graph := range part.Graphs {
			graphs[at] = payload.GraphWithoutNodes(graph, index*payload.GraphPartVectors, p.vanished)
		}
		stripped[index] = payload.GraphPart{FieldName: part.FieldName, Graphs: graphs}
	}
	p.partsToWrite = stripped
	p.strippedFor = len(p.vanished)
	return stripped
}

func (p *CheckpointPlan) ReadNewFile(ctx context.Context, index int) (NewVectorFile, error) {
	if index < 0 || index >= p.newFiles {
		return NewVectorFile{}, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"A checkpoint asked for a new vector file that its plan does not hold",
			map[string]any{"index": float64(index), "newFiles": float64(p.newFiles)})
	}
	f := p.field
	if err := f.ensureFilesOpen(); err != nil {
		return NewVectorFile{}, err
	}
	start := index * p.capacity
	planned := p.planned[start:min(len(p.planned), start+p.capacity)]
	f.writeMu.Lock()
	file, err := f.readPlannedFile(ctx, p, planned)
	f.writeMu.Unlock()
	if err != nil {
		return NewVectorFile{}, err
	}
	p.mu.Lock()
	for position, ordinal := range file.Ordinals {
		if ordinal == noLiveVectorAtPosition {
			p.vanished[p.firstWrittenNumber+start+position] = struct{}{}
		}
	}
	p.mu.Unlock()
	return file, nil
}

func (p *CheckpointPlan) Release() {
	p.mu.Lock()
	release := p.stillPinned
	p.stillPinned = false
	p.mu.Unlock()
	if !release {
		return
	}
	p.field.writeMu.Lock()
	p.store.pins.unpin()
	p.field.writeMu.Unlock()
}

func (f *Field) RecordCheckpoint(plan *CheckpointPlan, written []WrittenVectorFile) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if plan.unchanged || plan.store != f.store || f.disposed {
		return
	}
	saved := make([]savedVectorFile, 0, len(plan.keptFiles)+len(written))
	saved = append(saved, plan.keptFiles...)
	for _, file := range written {
		saved = append(saved, savedVectorFile{
			id: file.ID, key: file.Key, ordinals: file.Ordinals,
			calibration: plan.signature.calibration, hasCalibration: plan.signature.hasCalibration,
		})
	}
	f.savedFiles = saved
	signature := plan.signature
	f.savedSignature = &signature
}
