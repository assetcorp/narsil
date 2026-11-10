package vector

import (
	"context"
	"encoding/binary"
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

func storeEmptiedWhilePinned() error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"The vector store was emptied while a checkpoint read the vectors it captured, so the checkpoint stops", nil)
}

func (f *Field) heldOrdinalOf(vector plannedVector, pinned bool) (int32, bool) {
	if pinned || vector.tombstoned || f.store.holdsDocument(vector.ordinal) {
		return vector.ordinal, true
	}
	return f.store.ordinalOf(vector.docID)
}

func (f *Field) readPlannedVector(ordinal int32, target []float32, pinned bool) (bool, error) {
	if pinned {
		return f.store.readPinnedVector(ordinal, target)
	}
	return f.store.readVector(f.store.tables, ordinal, target), nil
}

func vectorBytes(vectors []float32) []byte {
	data := make([]byte, len(vectors)*4)
	for index, value := range vectors {
		binary.LittleEndian.PutUint32(data[index*4:], math.Float32bits(value))
	}
	return data
}

func (f *Field) readPlannedFile(ctx context.Context, plan *CheckpointPlan, planned []plannedVector) (NewVectorFile, error) {
	intact := plan.store == f.store && !f.disposed
	if plan.pinsRetired && !intact {
		return NewVectorFile{}, storeEmptiedWhilePinned()
	}
	dimension := f.config.dimension
	count := len(planned)
	vectors := make([]float32, count*dimension)
	magnitudes := make([]float64, count)
	ordinals := make([]int32, count)
	docIDs := make([]string, count)
	tombstonedAt := map[int]int32{}
	for position, vector := range planned {
		if position%scanChunkOrdinals == 0 {
			if err := ctx.Err(); err != nil {
				return NewVectorFile{}, err
			}
		}
		docIDs[position] = vector.docID
		ordinals[position] = noLiveVectorAtPosition
		if !intact {
			continue
		}
		held, known := f.heldOrdinalOf(vector, plan.pinsRetired)
		if !known {
			continue
		}
		read, err := f.readPlannedVector(held, vectors[position*dimension:(position+1)*dimension], plan.pinsRetired)
		if err != nil {
			return NewVectorFile{}, err
		}
		if !read {
			continue
		}
		magnitudes[position] = f.store.magnitude(held)
		ordinals[position] = held
		if vector.tombstoned {
			tombstonedAt[position] = held
		}
	}
	var codes *payload.Codes
	if intact {
		var err error
		if codes, err = f.codesOfPlannedFile(plan, docIDs, tombstonedAt, vectors, ordinals); err != nil {
			return NewVectorFile{}, err
		}
	}
	return NewVectorFile{
		Payload: payload.VectorFile{
			FieldName: f.config.fieldName, Dimension: dimension, DocIDs: docIDs, Codes: codes, Vectors: vectorBytes(vectors),
		},
		Ordinals: ordinals,
		Dead: deadBitsWhere(count, func(position int) bool {
			return planned[position].tombstoned || ordinals[position] == noLiveVectorAtPosition
		}),
		Magnitudes: magnitudes,
	}, nil
}

func (f *Field) centroidIs(planned []float64) bool {
	if !f.calibrated() {
		return false
	}
	current := f.store.centroidValues()
	if len(current) != len(planned) {
		return false
	}
	for index, component := range current {
		if float64(component) != planned[index] {
			return false
		}
	}
	return true
}

func (f *Field) storedRecordOf(ordinal int32) []byte {
	if !f.store.holdsCode(ordinal) {
		return nil
	}
	return f.store.recordSlot(f.store.tables, ordinal)
}

func (f *Field) recordOfDocument(docID string) ([]byte, error) {
	ordinal, held := f.store.ordinalOf(docID)
	if !held {
		return nil, nil
	}
	if record := f.storedRecordOf(ordinal); record != nil {
		return record, nil
	}
	if err := f.writeCodesOf([]int32{ordinal}); err != nil {
		return nil, err
	}
	return f.storedRecordOf(ordinal), nil
}

func (f *Field) codesOfPlannedFile(plan *CheckpointPlan, docIDs []string, tombstonedAt map[int]int32,
	vectors []float32, ordinals []int32) (*payload.Codes, error) {
	if plan.centroid == nil || !f.quantises() {
		return nil, nil
	}
	if plan.pinsRetired || !f.centroidIs(plan.centroid) {
		return f.codesAgainstCentroid(plan.centroid, vectors, ordinals)
	}
	stride := payload.RecordBytes(f.config.dimension, uint8(f.config.bits))
	records := make([]byte, len(docIDs)*stride)
	for position, docID := range docIDs {
		var record []byte
		if ordinal, tombstoned := tombstonedAt[position]; tombstoned {
			record = f.storedRecordOf(ordinal)
		} else {
			var err error
			if record, err = f.recordOfDocument(docID); err != nil {
				return nil, err
			}
		}
		copy(records[position*stride:(position+1)*stride], record)
	}
	return &payload.Codes{Bits: uint8(f.config.bits), Centroid: slices.Clone(plan.centroid), Records: records}, nil
}
