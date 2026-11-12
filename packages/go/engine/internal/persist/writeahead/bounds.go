package writeahead

import "github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"

type Bounds struct {
	Found               bool
	ActiveSegmentSeqNo  uint64
	DurableByteLength   uint64
	HighestDurableSeqNo uint64
}

func ReadBounds(directory *storage.Directory, indexName string, partitionID uint32) (Bounds, error) {
	slot, found, err := readMarker(directory, indexName, partitionID)
	if err != nil || !found {
		return Bounds{}, err
	}
	return Bounds{Found: true, ActiveSegmentSeqNo: slot.ActiveSegmentSeqNo, DurableByteLength: slot.DurableByteLength,
		HighestDurableSeqNo: slot.HighestDurableSeqNo}, nil
}

func ListSegments(directory *storage.Directory, indexName string, partitionID uint32) ([]SegmentRef, error) {
	return listSegments(directory, indexName, partitionID)
}
