package vector

import (
	"context"
	"slices"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

const (
	noLiveVectorAtPosition  int32 = -1
	calibrationNeverCurrent int32 = -1
)

type CheckpointRestoreShape struct {
	LiveVectors int
	HoldsGraph  bool
	Graph       *payload.GraphParts
}

type VectorFileByParts struct {
	Magnitudes []float64
	VectorAt   func(position int, target []float32) error
}

type LoadedVectorFile struct {
	ID       uint64
	Key      string
	Payload  payload.VectorFile
	Dead     []byte
	Location *VectorPartFile
	ByParts  *VectorFileByParts
}

type restoredFile struct {
	id       uint64
	key      string
	ordinals []int32
	coded    bool
}

type CheckpointRestore struct {
	field         *Field
	cold          bool
	restoresCodes bool
	graph         *payload.GraphParts
	graphNodes    *payload.NumberedGraphParts
	files         []restoredFile
	tombstoned    map[int32]struct{}
	nextNumber    int
	sharedCodes   *payload.Codes
	codesAgree    bool
	ended         bool
	generation    int64
	ctx           context.Context
}

func (f *Field) RestoreCheckpoint(ctx context.Context, shape CheckpointRestoreShape) (*CheckpointRestore, error) {
	return f.beginCheckpointRestore(ctx, shape)
}

func (f *Field) untilBuildsIdleLocked(ctx context.Context) error {
	for f.builds.running {
		idle := f.builds.idle
		f.writeMu.Unlock()
		select {
		case <-idle:
		case <-ctx.Done():
			f.writeMu.Lock()
			return ctx.Err()
		}
		f.writeMu.Lock()
	}
	return nil
}

func (f *Field) emptyFieldBeforeRestore() error {
	store, err := newStoreMemory(f.config.dimension, f.config.bits, f.config.blockBytes)
	if err != nil {
		return err
	}
	previousStore, previousGraph, previousFresh := f.store, f.graph, f.fresh
	f.tombstones.forget()
	f.buffer.forget()
	clear(f.pendingLocations)
	f.store, f.graph, f.fresh = store, nil, nil
	f.shuffledBuildCount, f.hasShuffledBuild, f.compactedNodeCount = 0, false, 0
	f.forgetCalibration()
	f.savedFiles, f.savedSignature = nil, nil
	if err := f.publish(store, nil); err != nil {
		f.store, f.graph, f.fresh = previousStore, previousGraph, previousFresh
		store.discard()
		return err
	}
	if previousGraph != nil {
		previousGraph.resource.drop()
	}
	if previousFresh != nil {
		previousFresh.resource.drop()
	}
	previousStore.discard()
	return nil
}

func (f *Field) beginCheckpointRestore(ctx context.Context, shape CheckpointRestoreShape) (*CheckpointRestore, error) {
	if shape.Graph != nil {
		if err := payload.RequireBoundedUpperLists(*shape.Graph); err != nil {
			return nil, err
		}
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return nil, f.disposedError()
	}
	f.restoring++
	if err := f.untilBuildsIdleLocked(ctx); err != nil {
		f.restoring--
		return nil, err
	}
	if f.disposed {
		f.restoring--
		return nil, f.disposedError()
	}
	if err := f.emptyFieldBeforeRestore(); err != nil {
		f.restoring--
		return nil, err
	}
	f.restoreGeneration++
	restore := &CheckpointRestore{
		generation:    f.restoreGeneration,
		field:         f,
		cold:          f.readsFromDisk() && (shape.HoldsGraph || shape.LiveVectors >= f.config.promotionThreshold),
		restoresCodes: f.quantises() && shape.HoldsGraph,
		tombstoned:    map[int32]struct{}{},
		codesAgree:    true,
		ctx:           ctx,
	}
	if shape.Graph != nil && len(shape.Graph.Graphs) > 0 {
		restore.graphNodes = &shape.Graph.Graphs[0]
		restore.graph = shape.Graph
	}
	return restore, nil
}

func (r *CheckpointRestore) end() {
	if r.ended {
		return
	}
	r.ended = true
	r.field.restoring--
}

func (r *CheckpointRestore) currentLocked() bool {
	if !r.ended && r.generation == r.field.restoreGeneration {
		return true
	}
	r.end()
	return false
}

func (r *CheckpointRestore) Abort() error {
	f := r.field
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !r.currentLocked() {
		return nil
	}
	r.end()
	if f.disposed {
		return nil
	}
	return f.emptyFieldBeforeRestore()
}

func (r *CheckpointRestore) graphHoldsNodeFor(number int) bool {
	return r.graphNodes != nil && r.graphNodes.TopLayer(number) >= 0
}

func (f *Field) restoreRecord(ordinal int32, record []byte) {
	store := f.store
	slot := store.recordSlot(store.tables, ordinal)
	if ordinal < 0 || ordinal >= store.slots() || slot == nil || len(record) != len(slot) {
		return
	}
	copy(slot, record)
	present := store.head.codePresent.pointer()
	if loadByte(present, int(ordinal)) == 1 {
		return
	}
	storeByte(present, int(ordinal), 1)
	store.word(core.StoreWordCodeCount).Add(1)
}

func sameCentroid(a, b []float64) bool {
	return slices.Equal(a, b)
}

func (r *CheckpointRestore) restoreRecords(file payload.VectorFile, ordinals []int32) {
	f := r.field
	if !r.restoresCodes || !r.codesAgree {
		return
	}
	codes := file.Codes
	if codes == nil || uint32(codes.Bits) != f.config.bits {
		r.codesAgree = false
		return
	}
	if r.sharedCodes == nil {
		r.sharedCodes = codes
		centroid := make([]float32, len(codes.Centroid))
		for index, component := range codes.Centroid {
			centroid[index] = float32(component)
		}
		f.writeCentroid(centroid)
	} else if !sameCentroid(r.sharedCodes.Centroid, codes.Centroid) {
		r.codesAgree = false
		return
	}
	for position, ordinal := range ordinals {
		if ordinal == noLiveVectorAtPosition {
			continue
		}
		record := file.Record(position)
		if _, dead := r.tombstoned[ordinal]; dead {
			f.restoreRecord(ordinal, record)
			continue
		}
		if current, held := f.store.ordinalOf(file.DocIDs[position]); held {
			f.restoreRecord(current, record)
		}
	}
}

func dimensionOfPayload(expected, received int) error {
	return narsilerr.New(narsilerr.CodeVectorDimensionMismatch, "Payload dimension "+strconv.Itoa(received)+
		" does not match index dimension "+strconv.Itoa(expected),
		map[string]any{"expected": float64(expected), "received": float64(received)})
}
