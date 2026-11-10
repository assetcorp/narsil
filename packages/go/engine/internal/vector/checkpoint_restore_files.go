package vector

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func restoreEnded() error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		"The checkpoint restore of this vector field has already finished or stopped", nil)
}

type restoredVector struct {
	values   []float32
	position int
	file     *LoadedVectorFile
}

func (v *restoredVector) read() error {
	if v.file.ByParts != nil {
		return v.file.ByParts.VectorAt(v.position, v.values)
	}
	if !v.file.Payload.Vector(v.position, v.values) {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"A vector file holds fewer vectors than its document IDs", map[string]any{"position": v.position})
	}
	return nil
}

func (r *CheckpointRestore) fileLocation(file *LoadedVectorFile) (bool, int32, error) {
	f := r.field
	onDisk := f.readsFromDisk() && file.Location != nil
	if !onDisk || !r.cold {
		return onDisk, -1, nil
	}
	index, err := f.store.addVectorFile(file.Location.Path)
	return onDisk, index, err
}

func diskLocationAt(file *LoadedVectorFile, position int, dimension int) (diskLocation, bool) {
	offset := file.Location.VectorsOffset + int64(position)*int64(dimension)*4
	if offset < 0 || offset > math.MaxUint32 {
		return diskLocation{}, false
	}
	return diskLocation{offset: uint32(offset)}, true
}

func (r *CheckpointRestore) restoreVector(file *LoadedVectorFile, position int, firstNumber int, onDisk bool,
	fileIndex int32, vector *restoredVector) (int32, error) {
	f := r.field
	store := f.store
	docID := file.Payload.DocIDs[position]
	dead := isDead(file.Dead, position)
	if dead && !r.graphHoldsNodeFor(firstNumber+position) {
		return noLiveVectorAtPosition, nil
	}
	var location *diskLocation
	if onDisk {
		at, valid := diskLocationAt(file, position, f.config.dimension)
		if !valid {
			return noLiveVectorAtPosition, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				"A vector file places a vector past the reach of a vector offset", map[string]any{"position": position})
		}
		at.fileIndex = fileIndex
		location = &at
	}
	vector.position = position
	if dead {
		if err := vector.read(); err != nil {
			return noLiveVectorAtPosition, err
		}
		cold := location
		if fileIndex < 0 {
			cold = nil
		}
		ordinal, _, err := store.insertReplaced(docID, vector.values, cold)
		if err != nil {
			return noLiveVectorAtPosition, err
		}
		r.tombstoned[ordinal] = struct{}{}
		return ordinal, nil
	}
	if replaced, held := store.ordinalOf(docID); held {
		f.clearCodes(replaced)
	}
	if fileIndex >= 0 {
		magnitude := math.NaN()
		if file.ByParts != nil && position < len(file.ByParts.Magnitudes) {
			magnitude = file.ByParts.Magnitudes[position]
		} else {
			if err := vector.read(); err != nil {
				return noLiveVectorAtPosition, err
			}
			magnitude = magnitudeOf(vector.values)
		}
		ordinal, _, err := store.insertCold(docID, magnitude, *location, PartitionUnknown)
		return ordinal, err
	}
	if err := vector.read(); err != nil {
		return noLiveVectorAtPosition, err
	}
	ordinal, _, err := store.insert(docID, vector.values, PartitionUnknown, false)
	if err != nil {
		return noLiveVectorAtPosition, err
	}
	if onDisk {
		f.pendingLocations[docID] = pendingLocation{path: file.Location.Path, offset: int64(location.offset)}
	}
	return ordinal, nil
}

func (r *CheckpointRestore) AddFile(file LoadedVectorFile) error {
	f := r.field
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !r.currentLocked() {
		return restoreEnded()
	}
	if f.disposed {
		return f.disposedError()
	}
	if file.Payload.Dimension != f.config.dimension {
		return dimensionOfPayload(f.config.dimension, file.Payload.Dimension)
	}
	onDisk, fileIndex, err := r.fileLocation(&file)
	if err != nil {
		return err
	}
	count := len(file.Payload.DocIDs)
	ordinals := make([]int32, count)
	firstNumber := r.nextNumber
	r.nextNumber += count
	vector := &restoredVector{values: make([]float32, f.config.dimension), file: &file}
	var failure error
	for position := range count {
		if position%scanChunkOrdinals == 0 {
			if failure = r.ctx.Err(); failure != nil {
				break
			}
		}
		ordinals[position], failure = r.restoreVector(&file, position, firstNumber, onDisk, fileIndex, vector)
		if failure != nil {
			break
		}
	}
	if failure == nil {
		r.restoreRecords(file.Payload, ordinals)
		r.files = append(r.files, restoredFile{id: file.ID, key: file.Key, ordinals: ordinals, coded: file.Payload.Codes != nil})
	}
	if err := f.publish(f.store, f.graph); err != nil && failure == nil {
		failure = err
	}
	return failure
}
