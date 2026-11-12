package persist

import (
	"context"
	"errors"
	"io"
	"os"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type LogChunk struct {
	Entries []wal.Entry
	Gap     bool
}

type LogChunkLimits struct {
	MaxBytes   int
	MaxEntries int
}

type chunkCollector struct {
	limits   LogChunkLimits
	expected uint64
	head     uint64
	bytes    int
	gap      bool
	entries  []wal.Entry
}

func (collector *chunkCollector) visit(entry wal.Entry, _ int64) bool {
	if entry.SeqNo < collector.expected {
		return false
	}
	if entry.SeqNo > collector.head {
		return true
	}
	if entry.SeqNo != collector.expected {
		collector.gap = true
		return true
	}
	entry.Document = slices.Clone(entry.Document)
	entry.PreviousDocument = slices.Clone(entry.PreviousDocument)
	collector.entries = append(collector.entries, entry)
	collector.expected++
	collector.bytes += len(entry.DocumentID) + len(entry.Document) + len(entry.PreviousDocument)
	return collector.expected > collector.head || collector.bytes >= collector.limits.MaxBytes ||
		len(collector.entries) >= collector.limits.MaxEntries
}

func (durable *Durable) ReadLogChunk(ctx context.Context, partitionID int, after uint64, head uint64,
	limits LogChunkLimits) (LogChunk, error) {
	directory, name := durable.manager.directory, durable.handle.Name
	bounds, err := writeahead.ReadBounds(directory, name, uint32(partitionID))
	if err != nil {
		return LogChunk{}, err
	}
	if bounds.Found {
		head = min(head, bounds.HighestDurableSeqNo)
	}
	if head <= after {
		return LogChunk{}, nil
	}
	segments, err := durable.feedSegments(uint32(partitionID))
	if err != nil {
		return LogChunk{}, err
	}
	first := -1
	for at, segment := range segments {
		if segment.start > after+1 {
			break
		}
		first = at
	}
	if first < 0 {
		return LogChunk{Gap: true}, nil
	}
	collector := &chunkCollector{limits: limits, expected: after + 1, head: head}
	for _, segment := range segments[first:] {
		if err := ctx.Err(); err != nil {
			return LogChunk{}, err
		}
		if segment.walKey != "" && bounds.Found && segment.start > bounds.ActiveSegmentSeqNo {
			break
		}
		done, found, err := durable.readFeedSegment(segment, bounds, collector)
		if err != nil {
			return LogChunk{}, err
		}
		if !found {
			collector.gap = true
		}
		if done || !found {
			break
		}
	}
	if len(collector.entries) == 0 {
		return LogChunk{Gap: true}, nil
	}
	return LogChunk{Entries: collector.entries}, nil
}

func (durable *Durable) openFeedSegment(segment feedSegment) (*os.File, bool, error) {
	directory := durable.manager.directory
	if segment.walKey != "" {
		file, err := openKey(directory, segment.walKey)
		if err != nil || file != nil {
			return file, true, err
		}
	}
	historyKey := segment.historyKey
	if historyKey == "" {
		segments, err := durable.feedSegments(segment.partition)
		if err != nil {
			return nil, false, err
		}
		for _, listed := range segments {
			if listed.start == segment.start {
				historyKey = listed.historyKey
			}
		}
		if historyKey == "" {
			return nil, false, nil
		}
	}
	file, err := openKey(directory, historyKey)
	return file, false, err
}

func (durable *Durable) readFeedSegment(segment feedSegment, bounds writeahead.Bounds,
	collector *chunkCollector) (bool, bool, error) {
	file, limit, err := durable.openReadableSegment(segment, bounds)
	if err != nil || file == nil {
		return false, false, err
	}
	defer file.Close()
	done, err := readSegmentEntries(file, limit, collector.visit)
	return done, true, err
}

func (durable *Durable) openReadableSegment(segment feedSegment, bounds writeahead.Bounds) (*os.File, int64, error) {
	file, fromLog, err := durable.openFeedSegment(segment)
	if err != nil || file == nil {
		return nil, 0, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, 0, readFailed(err)
	}
	limit := info.Size()
	if fromLog && bounds.Found && segment.start == bounds.ActiveSegmentSeqNo {
		limit = min(limit, int64(bounds.DurableByteLength))
	}
	return file, limit, nil
}

func openKey(directory *storage.Directory, key string) (*os.File, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	file, err := storage.OpenForReading(path)
	if err == nil {
		return file, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `Failed to read "`+key+`"`, err,
		map[string]any{"key": key})
}

func recordOverruns(offset int64) error {
	return narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
		"A log record overruns the readable region of its segment", map[string]any{"offset": offset})
}

func readFailed(err error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, "A log segment cannot be read for the change feed", err, nil)
}

func readSegmentEntries(file *os.File, limit int64, visit func(entry wal.Entry, start int64) bool) (bool, error) {
	header := make([]byte, wal.SegmentHeaderBytes)
	if _, err := file.ReadAt(header, 0); err != nil {
		return false, readFailed(err)
	}
	if _, err := wal.CheckSegmentHeader(header); err != nil {
		return false, err
	}
	offset := int64(wal.SegmentHeaderBytes)
	windowStart := offset
	var window, buffer []byte
	for offset < limit {
		frame, err := wal.ReadFrameAt(window, int(offset-windowStart))
		if err != nil {
			return false, err
		}
		if frame.Needed > 0 {
			if int64(frame.Needed) > limit-offset {
				return false, recordOverruns(offset)
			}
			size := int(min(max(int64(ChangesSegmentReadBytes), int64(frame.Needed)), limit-offset))
			if cap(buffer) < size {
				buffer = make([]byte, size)
			}
			read, err := file.ReadAt(buffer[:size], offset)
			if err != nil && !errors.Is(err, io.EOF) {
				return false, readFailed(err)
			}
			if read < frame.Needed {
				return false, recordOverruns(offset)
			}
			window, windowStart = buffer[:read], offset
			continue
		}
		start := offset
		offset = windowStart + int64(frame.End)
		if visit(frame.Entry, start) {
			return true, nil
		}
	}
	return false, nil
}
