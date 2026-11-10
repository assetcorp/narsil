package writeahead

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/commitmarker"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Replayed struct {
	HighestSeqNo       uint64
	HighestPrimaryTerm uint64
}

type activeTail struct {
	key           string
	cleanEnd      int
	segmentLength int
	lastReplayed  uint64
	replayedAny   bool
}

func readMarker(directory *storage.Directory, indexName string, partitionID uint32) (commitmarker.Slot, bool,
	error) {
	data, err := directory.ReadPrefix(MarkerKey(indexName, partitionID), commitmarker.FileBytes)
	if err != nil || data == nil {
		return commitmarker.Slot{}, false, err
	}
	slot, _, found := commitmarker.Decode(data).Current()
	return slot, found, nil
}

func durableRecordMissing(indexName string, partitionID uint32, highestRead uint64,
	marker commitmarker.Slot) error {
	return narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
		"A durable WAL record is missing: the highest recovered seqNo is below the commit marker",
		map[string]any{"indexName": indexName, "partitionId": partitionID, "highestRead": highestRead,
			"highestDurable": marker.HighestDurableSeqNo})
}

func sealedHeaderInvalid(key string, cause error) error {
	code := narsilerr.CodeOf(cause)
	if code == "" {
		code = narsilerr.CodePersistenceWalCorrupt
	}
	return narsilerr.Wrap(code, "Sealed WAL segment header invalid", cause, map[string]any{"key": key})
}

func Replay(directory *storage.Directory, indexName string, partitionID uint32, fromSeqNoExclusive uint64,
	apply func(wal.Entry) error) (Replayed, error) {
	result := Replayed{HighestSeqNo: fromSeqNoExclusive}
	if err := directory.Remove(PreparedKey(indexName, partitionID)); err != nil {
		return result, err
	}
	marker, found, err := readMarker(directory, indexName, partitionID)
	if err != nil || !found {
		return result, err
	}
	segments, err := listSegments(directory, indexName, partitionID)
	if err != nil {
		return result, err
	}
	visit := func(entry wal.Entry) error {
		if entry.SeqNo <= result.HighestSeqNo {
			return nil
		}
		if err := apply(entry); err != nil {
			return err
		}
		result.HighestSeqNo = entry.SeqNo
		result.HighestPrimaryTerm = max(result.HighestPrimaryTerm, entry.PrimaryTerm)
		return nil
	}
	var highestRead uint64
	track := func(entry wal.Entry) error {
		highestRead = max(highestRead, entry.SeqNo)
		return visit(entry)
	}
	var tail *activeTail
	for _, segment := range segments {
		if segment.StartSeqNo > marker.ActiveSegmentSeqNo {
			continue
		}
		data, err := directory.Read(segment.Key)
		if err != nil {
			return result, err
		}
		if data == nil {
			continue
		}
		if segment.StartSeqNo < marker.ActiveSegmentSeqNo {
			if _, err := wal.CheckSegmentHeader(data); err != nil {
				return result, sealedHeaderInvalid(segment.Key, err)
			}
			if err := wal.ScanDurableRegion(data, uint64(len(data)), track); err != nil {
				return result, err
			}
			continue
		}
		if err := wal.ScanDurableRegion(data, marker.DurableByteLength, track); err != nil {
			return result, err
		}
		if max(fromSeqNoExclusive, highestRead) < marker.HighestDurableSeqNo {
			return result, durableRecordMissing(indexName, partitionID, highestRead, marker)
		}
		current := &activeTail{key: segment.Key, segmentLength: len(data)}
		cleanEnd, err := wal.ScanTail(data, marker.DurableByteLength, max(highestRead, marker.HighestDurableSeqNo),
			func(entry wal.Entry) error {
				if err := visit(entry); err != nil {
					return err
				}
				current.lastReplayed = entry.SeqNo
				current.replayedAny = true
				return nil
			})
		if err != nil {
			return result, err
		}
		current.cleanEnd = cleanEnd
		tail = current
	}
	if max(fromSeqNoExclusive, highestRead) < marker.HighestDurableSeqNo {
		return result, durableRecordMissing(indexName, partitionID, highestRead, marker)
	}
	for _, segment := range segments {
		if segment.StartSeqNo > marker.ActiveSegmentSeqNo {
			if err := directory.Remove(segment.Key); err != nil {
				return result, err
			}
		}
	}
	if tail != nil {
		if err := makeTailDurable(directory, indexName, partitionID, marker, *tail); err != nil {
			return result, err
		}
	}
	return result, nil
}

func makeTailDurable(directory *storage.Directory, indexName string, partitionID uint32,
	marker commitmarker.Slot, tail activeTail) error {
	if !tail.replayedAny && tail.cleanEnd >= tail.segmentLength {
		return nil
	}
	handle, err := directory.OpenAppend(tail.key)
	if err != nil {
		return err
	}
	size, err := handle.Size()
	if err == nil {
		if int64(tail.cleanEnd) < size {
			err = handle.Truncate(int64(tail.cleanEnd))
		} else {
			err = handle.Sync()
		}
	}
	if closeErr := handle.Close(); err == nil {
		err = closeErr
	}
	if err != nil || !tail.replayedAny {
		return err
	}
	writer, err := openMarker(directory, indexName, partitionID)
	if err != nil {
		return err
	}
	err = writer.commit(marker.ActiveSegmentSeqNo, uint64(tail.cleanEnd),
		max(marker.HighestDurableSeqNo, tail.lastReplayed))
	if closeErr := writer.close(); err == nil {
		err = closeErr
	}
	return err
}

func TruncateCovered(directory *storage.Directory, indexName string, partitionID uint32, lastSeqNo uint64) error {
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
		if err := directory.Remove(segment.Key); err != nil {
			return err
		}
	}
	return nil
}

func HighestDurableSeqNo(directory *storage.Directory, indexName string, partitionID uint32) (uint64, error) {
	marker, found, err := readMarker(directory, indexName, partitionID)
	if err != nil || !found {
		return 0, err
	}
	return marker.HighestDurableSeqNo, nil
}
