package persist

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

func (durable *Durable) LogBytesAfter(partitionID int, after uint64) (uint64, error) {
	directory, name := durable.manager.directory, durable.handle.Name
	bounds, err := writeahead.ReadBounds(directory, name, uint32(partitionID))
	if err != nil {
		return 0, err
	}
	segments, err := durable.feedSegments(uint32(partitionID))
	if err != nil {
		return 0, err
	}
	first := 0
	for at, segment := range segments {
		if segment.start <= after+1 {
			first = at
		}
	}
	var total uint64
	for at := first; at < len(segments); at++ {
		segment := segments[at]
		if segment.walKey != "" && bounds.Found && segment.start > bounds.ActiveSegmentSeqNo {
			break
		}
		bytes, err := durable.segmentBytesAfter(segment, bounds, after, at == first && segment.start <= after)
		if err != nil {
			return 0, err
		}
		total += bytes
	}
	return total, nil
}

func (durable *Durable) segmentBytesAfter(segment feedSegment, bounds writeahead.Bounds, after uint64,
	holdsPosition bool) (uint64, error) {
	file, limit, err := durable.openReadableSegment(segment, bounds)
	if err != nil || file == nil {
		return 0, err
	}
	defer file.Close()
	if !holdsPosition {
		return uint64(max(limit-wal.SegmentHeaderBytes, 0)), nil
	}
	firstAbove := limit
	_, err = readSegmentEntries(file, limit, func(entry wal.Entry, start int64) bool {
		if entry.SeqNo <= after {
			return false
		}
		firstAbove = start
		return true
	})
	if err != nil {
		return 0, err
	}
	return uint64(limit - firstAbove), nil
}
