package writeahead

import (
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Config struct {
	Directory       *storage.Directory
	IndexName       string
	PartitionID     uint32
	SegmentMaxBytes int64
}

type Writer struct {
	config     Config
	durability sync.Mutex
	state      sync.Mutex
	group      groupCommit

	handle              *storage.AppendFile
	activeStartSeqNo    uint64
	activeBytes         int64
	highestAppended     uint64
	highestDurable      uint64
	marker              *markerWriter
	nextSegmentPrepared bool
	closed              bool
}

func NewWriter(config Config) *Writer {
	if config.SegmentMaxBytes <= 0 {
		config.SegmentMaxBytes = DefaultSegmentMaxBytes
	}
	writer := &Writer{config: config}
	writer.group.flush = writer.flush
	return writer
}

func (writer *Writer) notOpen() error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		`WAL segment for "`+writer.config.IndexName+`" partition `+
			strconv.FormatUint(uint64(writer.config.PartitionID), 10)+" is not open",
		map[string]any{"indexName": writer.config.IndexName, "partitionId": writer.config.PartitionID})
}

func (writer *Writer) markerWriter() (*markerWriter, error) {
	if writer.marker != nil {
		return writer.marker, nil
	}
	marker, err := openMarker(writer.config.Directory, writer.config.IndexName, writer.config.PartitionID)
	if err != nil {
		return nil, err
	}
	writer.marker = marker
	return marker, nil
}

func (writer *Writer) flush() error {
	writer.durability.Lock()
	defer writer.durability.Unlock()
	marker, err := writer.markerWriter()
	if err != nil {
		return err
	}
	writer.state.Lock()
	handle := writer.handle
	durableBytes := writer.activeBytes
	activeStart := writer.activeStartSeqNo
	durableSeqNo := max(writer.highestAppended, writer.highestDurable, marker.existingHighestSeen)
	writer.state.Unlock()
	if handle == nil {
		return nil
	}
	if err := handle.Sync(); err != nil {
		return err
	}
	if err := marker.commit(activeStart, uint64(durableBytes), durableSeqNo); err != nil {
		return err
	}
	writer.state.Lock()
	writer.highestDurable = max(writer.highestDurable, durableSeqNo)
	writer.state.Unlock()
	return nil
}

func (writer *Writer) flushHeld() error {
	if writer.handle == nil {
		return nil
	}
	marker, err := writer.markerWriter()
	if err != nil {
		return err
	}
	durableSeqNo := max(writer.highestAppended, writer.highestDurable, marker.existingHighestSeen)
	if err := writer.handle.Sync(); err != nil {
		return err
	}
	if err := marker.commit(writer.activeStartSeqNo, uint64(writer.activeBytes), durableSeqNo); err != nil {
		return err
	}
	writer.highestDurable = durableSeqNo
	return nil
}

func (writer *Writer) openSegmentHeld(key string) (bool, error) {
	start, ok := segmentStart(key, Prefix(writer.config.IndexName, writer.config.PartitionID))
	if !ok {
		return false, malformedSegmentKey(key)
	}
	handle, err := writer.config.Directory.OpenAppend(key)
	if err != nil {
		return false, err
	}
	size, err := handle.Size()
	if err != nil {
		_ = handle.Close()
		return false, err
	}
	created := size == 0
	if created {
		if err := handle.Append(wal.AppendSegmentHeader(nil)); err != nil {
			_ = handle.Close()
			return false, err
		}
		size = wal.SegmentHeaderBytes
	}
	writer.handle = handle
	writer.activeStartSeqNo = start
	writer.activeBytes = size
	if created {
		if err := writer.config.Directory.SyncDirectoryOf(key); err != nil {
			return true, err
		}
	}
	return created, nil
}

func (writer *Writer) ensureSegmentHeld(seqNo uint64) error {
	if writer.handle != nil {
		return nil
	}
	if writer.closed {
		return writer.notOpen()
	}
	segments, err := listSegments(writer.config.Directory, writer.config.IndexName, writer.config.PartitionID)
	if err != nil {
		return err
	}
	key := SegmentKey(writer.config.IndexName, writer.config.PartitionID, seqNo)
	if len(segments) > 0 {
		key = segments[len(segments)-1].Key
	}
	created, err := writer.openSegmentHeld(key)
	if err != nil {
		return err
	}
	if created {
		return writer.flushHeld()
	}
	return nil
}

func (writer *Writer) rollHeld(startSeqNo uint64) error {
	if writer.handle != nil {
		if err := writer.flushHeld(); err != nil {
			return err
		}
		handle := writer.handle
		writer.handle = nil
		if err := handle.Close(); err != nil {
			return err
		}
	}
	if _, err := writer.openSegmentHeld(SegmentKey(writer.config.IndexName, writer.config.PartitionID,
		startSeqNo)); err != nil {
		return err
	}
	return writer.flushHeld()
}

func (writer *Writer) AppendAll(entries []wal.Entry) error {
	if len(entries) == 0 {
		return nil
	}
	frames := make([][]byte, len(entries))
	total := int64(0)
	for index, entry := range entries {
		frame, err := wal.AppendRecord(nil, entry)
		if err != nil {
			return err
		}
		frames[index] = frame
		total += int64(len(frame))
	}
	writer.state.Lock()
	if writer.handle != nil && writer.activeBytes+total <= writer.config.SegmentMaxBytes {
		err := writer.writeFramesHeld(frames, entries[len(entries)-1].SeqNo)
		writer.state.Unlock()
		return err
	}
	writer.state.Unlock()
	writer.durability.Lock()
	defer writer.durability.Unlock()
	writer.state.Lock()
	defer writer.state.Unlock()
	if err := writer.ensureSegmentHeld(entries[0].SeqNo); err != nil {
		return err
	}
	start := 0
	for start < len(frames) {
		if writer.activeBytes > wal.SegmentHeaderBytes && (writer.activeBytes >= writer.config.SegmentMaxBytes ||
			writer.activeBytes+int64(len(frames[start])) > writer.config.SegmentMaxBytes) {
			if err := writer.rollHeld(entries[start].SeqNo); err != nil {
				return err
			}
		}
		end := writer.framesThatFit(frames, start)
		if err := writer.writeFramesHeld(frames[start:end], entries[end-1].SeqNo); err != nil {
			return err
		}
		start = end
	}
	return nil
}

func (writer *Writer) framesThatFit(frames [][]byte, start int) int {
	room := writer.config.SegmentMaxBytes - writer.activeBytes
	end := start + 1
	bytes := int64(len(frames[start]))
	for end < len(frames) && bytes+int64(len(frames[end])) <= room {
		bytes += int64(len(frames[end]))
		end++
	}
	return end
}

func (writer *Writer) writeFramesHeld(frames [][]byte, lastSeqNo uint64) error {
	if writer.handle == nil {
		return writer.notOpen()
	}
	total := 0
	for _, frame := range frames {
		total += len(frame)
	}
	if writer.activeBytes+int64(total) > envelope.MaxFileBytes {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"A log record of "+strconv.Itoa(total)+` bytes would carry WAL segment "`+writer.handle.Key()+
				`" past the file size limit of `+strconv.Itoa(envelope.MaxFileBytes)+" bytes",
			map[string]any{"indexName": writer.config.IndexName, "partitionId": writer.config.PartitionID,
				"bytes": total})
	}
	joined := frames[0]
	if len(frames) > 1 {
		joined = make([]byte, 0, total)
		for _, frame := range frames {
			joined = append(joined, frame...)
		}
	}
	if err := writer.handle.Append(joined); err != nil {
		return err
	}
	writer.activeBytes += int64(total)
	writer.highestAppended = max(writer.highestAppended, lastSeqNo)
	return nil
}

func (writer *Writer) Commit() error {
	return writer.group.commit()
}

func (writer *Writer) Close() error {
	writer.durability.Lock()
	defer writer.durability.Unlock()
	writer.state.Lock()
	defer writer.state.Unlock()
	var first error
	if writer.handle != nil {
		first = writer.flushHeld()
		if err := writer.handle.Close(); first == nil {
			first = err
		}
		writer.handle = nil
	}
	if writer.marker != nil {
		if err := writer.marker.close(); first == nil {
			first = err
		}
		writer.marker = nil
	}
	writer.closed = true
	return first
}

func (writer *Writer) Abandon() {
	writer.durability.Lock()
	defer writer.durability.Unlock()
	writer.state.Lock()
	defer writer.state.Unlock()
	if writer.handle != nil {
		_ = writer.handle.Close()
		writer.handle = nil
	}
	if writer.marker != nil {
		_ = writer.marker.close()
		writer.marker = nil
	}
	writer.closed = true
}
