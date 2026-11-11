package writeahead

import "github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"

func RetireCovered(directory *storage.Directory, indexName string, partitionID uint32, lastSeqNo uint64,
	retire func(segment SegmentRef) error) error {
	marker, found, err := readMarker(directory, indexName, partitionID)
	if err != nil || !found {
		return err
	}
	segments, err := listSegments(directory, indexName, partitionID)
	if err != nil {
		return err
	}
	for index, segment := range segments {
		if segment.StartSeqNo >= marker.ActiveSegmentSeqNo {
			break
		}
		if index+1 >= len(segments) || segments[index+1].StartSeqNo > lastSeqNo+1 {
			break
		}
		if err := retire(segment); err != nil {
			return err
		}
	}
	return nil
}

func FirstSegmentStart(directory *storage.Directory, indexName string, partitionID uint32) (uint64, bool, error) {
	segments, err := listSegments(directory, indexName, partitionID)
	if err != nil || len(segments) == 0 {
		return 0, false, err
	}
	return segments[0].StartSeqNo, true, nil
}
