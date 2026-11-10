package vector

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const PartitionUnknown int32 = -1

func (f *Field) disposedError() error {
	return narsilerr.New(narsilerr.CodeIndexNotFound, "the vector field was disposed",
		map[string]any{"indexName": f.config.indexName, "field": f.config.fieldName})
}

func (f *Field) validateVector(docID string, values []float32) error {
	if len(values) != f.config.dimension {
		return dimensionMismatch(f.config.dimension, len(values))
	}
	if err := schema.ValidateDocID(docID); err != nil {
		return err
	}
	for index, value := range values {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return narsilerr.New(narsilerr.CodeDocValidationFailed,
				"every element of a vector must be a finite number",
				map[string]any{"field": f.config.fieldName, "docId": docID, "position": float64(index)})
		}
	}
	return nil
}

func (f *Field) Insert(docID string, values []float32, partition int32) error {
	if err := f.validateVector(docID, values); err != nil {
		return err
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	return f.insertLocked(docID, values, partition)
}

func (f *Field) insertLocked(docID string, values []float32, partition int32) error {
	if f.disposed {
		return f.disposedError()
	}
	if f.cold != nil {
		f.revision.Add(1)
		held := append([]float32(nil), values...)
		f.cold.insert(docID, held, partition, f)
		f.cold.writes = append(f.cold.writes, func() error { return f.applyInsert(docID, held, partition) })
		return nil
	}
	return f.applyInsert(docID, values, partition)
}

func (f *Field) holdsThisVectorAlready(docID string, ordinal int32, values []float32) bool {
	if f.tombstones.has(docID) {
		return false
	}
	held := make([]float32, f.config.dimension)
	if !f.store.readVector(f.store.tables, ordinal, held) {
		return false
	}
	for index, value := range values {
		if held[index] != value {
			return false
		}
	}
	return true
}

func (f *Field) graphHoldsNode(ordinal int32) bool {
	return (f.graph != nil && f.graph.holdsNode(ordinal)) || (f.fresh != nil && f.fresh.holdsNode(ordinal))
}

func (f *Field) applyInsert(docID string, values []float32, partition int32) error {
	store := f.store
	previous, hadPrevious := store.ordinalOf(docID)
	if hadPrevious && f.holdsThisVectorAlready(docID, previous, values) {
		if partition >= 0 && store.table.partition(previous) != partition {
			f.revision.Add(1)
			store.setPartition(docID, partition)
		}
		return nil
	}
	f.revision.Add(1)
	wasTombstoned := f.tombstones.delete(store, docID)
	graphHoldsPrevious := hadPrevious && f.graphHoldsNode(previous)
	_, changed, err := store.insert(docID, values, partition, graphHoldsPrevious)
	if err != nil {
		if wasTombstoned {
			f.tombstones.add(store, docID)
		}
		return f.publishAfterFailure(changed, err)
	}
	if hadPrevious {
		if err := f.markTombstoneOrdinal(f.graph, previous); err != nil {
			return f.publishAfterFailure(changed, err)
		}
		if err := f.markTombstoneOrdinal(f.fresh, previous); err != nil {
			return f.publishAfterFailure(changed, err)
		}
		if !graphHoldsPrevious {
			f.clearCodes(previous)
		}
	}
	f.buffer.add(store, docID)
	delete(f.pendingLocations, docID)
	if changed {
		return f.publish(store, f.graph)
	}
	return nil
}

func (f *Field) publishAfterFailure(changed bool, failure error) error {
	if changed {
		if err := f.publish(f.store, f.graph); err != nil {
			return err
		}
	}
	return failure
}

func (f *Field) Remove(docID string) error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	return f.removeLocked(docID)
}

func (f *Field) removeLocked(docID string) error {
	if f.disposed {
		return f.disposedError()
	}
	if f.cold != nil {
		if !f.cold.remove(docID, f) {
			return nil
		}
		f.revision.Add(1)
		f.cold.writes = append(f.cold.writes, func() error { return f.applyRemove(docID) })
		return nil
	}
	return f.applyRemove(docID)
}

func (f *Field) applyRemove(docID string) error {
	store := f.store
	ordinal, held := store.ordinalOf(docID)
	if !held {
		return nil
	}
	f.revision.Add(1)
	f.tombstones.add(store, docID)
	f.buffer.delete(store, docID)
	delete(f.pendingLocations, docID)
	return f.markTombstoneOrdinal(f.graph, ordinal)
}

func (f *Field) GetVector(docID string) ([]float32, bool) {
	for hold := f.coldHoldNow(); hold != nil; hold = f.coldHoldNow() {
		values, held := f.coldVectorOf(hold, docID)
		if f.coldHoldNow() == hold {
			return values, held
		}
	}
	if err := f.ensureFilesOpen(); err != nil {
		return nil, false
	}
	current := f.acquireLayout()
	if current == nil {
		return nil, false
	}
	defer current.done()
	store := current.store
	ordinal, held := store.ordinalOf(docID)
	if !held || !liveOrdinal(store, ordinal) {
		return nil, false
	}
	values := make([]float32, store.dimension)
	if !store.readStoredVector(current.tables, ordinal, values) {
		return nil, false
	}
	return values, true
}

func (f *Field) Has(docID string) bool {
	for hold := f.coldHoldNow(); hold != nil; hold = f.coldHoldNow() {
		held := f.coldHas(hold, docID)
		if f.coldHoldNow() == hold {
			return held
		}
	}
	current := f.acquireLayout()
	if current == nil {
		return false
	}
	defer current.done()
	ordinal, held := current.store.ordinalOf(docID)
	return held && liveOrdinal(current.store, ordinal)
}

func (f *Field) PartitionsKnown() bool {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	return f.cold != nil || f.store.unknownParts == 0
}

func (f *Field) AssignPartitions(resolve func(docID string) (int32, bool)) {
	f.writeMu.Lock()
	if f.cold != nil || f.disposed {
		f.writeMu.Unlock()
		return
	}
	store := f.store
	unresolved := map[string]struct{}{}
	for ordinal := range store.slots() {
		if store.table.partition(ordinal) >= 0 {
			continue
		}
		if docID, held := store.docIDOf(ordinal); held {
			unresolved[docID] = struct{}{}
		}
	}
	f.writeMu.Unlock()
	resolved := make(map[string]int32, len(unresolved))
	for docID := range unresolved {
		if partition, known := resolve(docID); known && partition >= 0 {
			resolved[docID] = partition
		}
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.cold != nil || f.disposed || f.store != store {
		return
	}
	for docID := range unresolved {
		ordinal, held := store.ordinalOf(docID)
		if !held || store.table.partition(ordinal) >= 0 {
			continue
		}
		if partition, known := resolved[docID]; known {
			store.setPartition(docID, partition)
			continue
		}
		store.forgetPartition(docID)
	}
}
