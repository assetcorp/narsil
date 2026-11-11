package writeahead

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

var errRangeRead = errors.New("every record of the range is read")

func rangeRecordMissing(indexName string, partitionID uint32, expected uint64, found uint64) error {
	return narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
		"A log record that the checkpoint covers is missing from the write-ahead log",
		map[string]any{"indexName": indexName, "partitionId": partitionID, "expectedSeqNo": expected,
			"foundSeqNo": found})
}

func ReadRange(directory *storage.Directory, indexName string, partitionID uint32, fromSeqNoExclusive uint64,
	toSeqNoInclusive uint64, visit func(wal.Entry) error) error {
	if toSeqNoInclusive <= fromSeqNoExclusive {
		return nil
	}
	marker, found, err := readMarker(directory, indexName, partitionID)
	if err != nil {
		return err
	}
	if !found {
		return rangeRecordMissing(indexName, partitionID, fromSeqNoExclusive+1, 0)
	}
	segments, err := listSegments(directory, indexName, partitionID)
	if err != nil {
		return err
	}
	expected := fromSeqNoExclusive + 1
	take := func(entry wal.Entry) error {
		if entry.SeqNo < expected {
			return nil
		}
		if entry.SeqNo != expected {
			return rangeRecordMissing(indexName, partitionID, expected, entry.SeqNo)
		}
		if err := visit(entry); err != nil {
			return err
		}
		expected++
		if expected > toSeqNoInclusive {
			return errRangeRead
		}
		return nil
	}
	for at, segment := range segments {
		if segment.StartSeqNo > marker.ActiveSegmentSeqNo || segment.StartSeqNo > toSeqNoInclusive {
			break
		}
		if at+1 < len(segments) && segments[at+1].StartSeqNo <= expected &&
			segments[at+1].StartSeqNo <= marker.ActiveSegmentSeqNo {
			continue
		}
		data, err := directory.Read(segment.Key)
		if err != nil {
			return err
		}
		if data == nil {
			continue
		}
		limit := uint64(len(data))
		if segment.StartSeqNo == marker.ActiveSegmentSeqNo {
			limit = min(limit, marker.DurableByteLength)
		}
		err = wal.ScanDurableRegion(data, limit, take)
		if errors.Is(err, errRangeRead) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return rangeRecordMissing(indexName, partitionID, expected, 0)
}
