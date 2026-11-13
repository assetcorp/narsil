package writeahead

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const commitRoundsBeforeRefusal = 2

type syncedPoint struct {
	start    uint64
	bytes    int64
	appended uint64
	valid    bool
}

func (point syncedPoint) covers(current syncedPoint) bool {
	return point.valid && point.start == current.start && point.bytes == current.bytes
}

func (writer *Writer) pointHeld() syncedPoint {
	return syncedPoint{start: writer.activeStartSeqNo, bytes: writer.activeBytes, appended: writer.highestAppended,
		valid: true}
}

func (writer *Writer) recordSyncedHeld(point syncedPoint, durableSeqNo uint64) {
	writer.highestDurable = max(writer.highestDurable, durableSeqNo)
	point.appended = max(point.appended, writer.synced.appended)
	writer.synced = point
}

func (writer *Writer) failHeld(err error) error {
	if writer.failure == nil {
		writer.failure = err
	}
	return writer.failure
}

func (writer *Writer) fail(err error) error {
	writer.state.Lock()
	defer writer.state.Unlock()
	return writer.failHeld(err)
}

func (writer *Writer) CommitThrough(seqNo uint64) error {
	for range commitRoundsBeforeRefusal {
		writer.state.Lock()
		failure, covered, open := writer.failure, writer.synced.appended >= seqNo, writer.handle != nil
		writer.state.Unlock()
		if failure != nil {
			return failure
		}
		if covered {
			return nil
		}
		if !open {
			return writer.notOpen()
		}
		if err := writer.group.commit(); err != nil {
			return err
		}
	}
	writer.state.Lock()
	failure, covered := writer.failure, writer.synced.appended >= seqNo
	writer.state.Unlock()
	if failure != nil || covered {
		return failure
	}
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"Log record "+strconv.FormatUint(seqNo, 10)+` of "`+writer.config.IndexName+`" partition `+
			strconv.FormatUint(uint64(writer.config.PartitionID), 10)+" is not durable after its commit",
		map[string]any{"indexName": writer.config.IndexName, "partitionId": writer.config.PartitionID,
			"seqNo": seqNo})
}
