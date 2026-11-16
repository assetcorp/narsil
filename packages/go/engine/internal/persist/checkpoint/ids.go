package checkpoint

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type IDReserver interface {
	ReserveSegmentID(partitionID uint32, floor uint64) uint64
	ReserveVectorFileID(fieldPath string, floor uint64) uint64
	ReserveGraphGeneration(fieldPath string, floor uint64) uint64
}

func reserverOf(store Store) (IDReserver, bool) {
	reserver, reserves := store.(IDReserver)
	return reserver, reserves
}

func usedEverySegmentID(partitionID uint32) error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"The partition has used every segment number a manifest accepts",
		map[string]any{"partitionId": partitionID})
}

func nextSegmentID(store Store, entry *manifest.PartitionEntry) (uint64, error) {
	id := entry.NextSegmentID
	if reserver, reserves := reserverOf(store); reserves {
		id = reserver.ReserveSegmentID(entry.PartitionID, id)
	}
	if id > manifest.MaxSegmentID {
		return 0, usedEverySegmentID(entry.PartitionID)
	}
	entry.NextSegmentID = id + 1
	return id, nil
}

func nextVectorFileID(store Store, ref *manifest.VectorFieldRef) uint64 {
	id := ref.NextFileID
	if reserver, reserves := reserverOf(store); reserves {
		id = reserver.ReserveVectorFileID(ref.FieldPath, id)
	}
	ref.NextFileID = id + 1
	return id
}

func nextGraphGeneration(store Store, ref *manifest.VectorFieldRef) uint64 {
	generation := ref.GraphGeneration + 1
	if reserver, reserves := reserverOf(store); reserves {
		generation = reserver.ReserveGraphGeneration(ref.FieldPath, generation)
	}
	ref.GraphGeneration = generation
	return generation
}
