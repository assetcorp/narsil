package corepartition

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func corruptedPartition(reason string, ordinal uint32) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "The partition is corrupted: "+reason,
		map[string]any{"ordinal": float64(ordinal)})
}

func alreadyExists(id string, partitionID int) error {
	return narsilerr.New(narsilerr.CodeDocAlreadyExists,
		`Document "`+id+`" already exists in partition `+strconv.Itoa(partitionID),
		map[string]any{"docId": id, "partitionId": partitionID})
}

func notFound(id string) error {
	return narsilerr.New(narsilerr.CodeDocNotFound, `Document "`+id+`" not found in any partition`, map[string]any{"docId": id})
}
