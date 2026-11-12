package writeahead

import "github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"

func (writer *Writer) holdsRecordsHeld() bool {
	return writer.handle != nil && writer.activeBytes > wal.SegmentHeaderBytes &&
		writer.highestAppended >= writer.activeStartSeqNo
}

func (writer *Writer) PrepareCheckpointRoll() error {
	writer.durability.Lock()
	defer writer.durability.Unlock()
	writer.state.Lock()
	holds := writer.holdsRecordsHeld()
	writer.state.Unlock()
	if !holds {
		return nil
	}
	key := PreparedKey(writer.config.IndexName, writer.config.PartitionID)
	prepared, err := writer.config.Directory.OpenAppend(key)
	if err != nil {
		return err
	}
	defer prepared.Close()
	version := writer.newSegmentVersion(wal.FormatVersion)
	if err := writeEmptySegment(prepared, version); err != nil {
		return err
	}
	writer.nextSegmentPrepared = true
	writer.preparedVersion = version
	return nil
}

func (writer *Writer) RollForCheckpoint() error {
	writer.durability.Lock()
	defer writer.durability.Unlock()
	writer.state.Lock()
	defer writer.state.Unlock()
	prepared := writer.nextSegmentPrepared
	writer.nextSegmentPrepared = false
	if !writer.holdsRecordsHeld() {
		return nil
	}
	if !prepared {
		return writer.rollHeld(writer.highestAppended+1, wal.FormatVersion)
	}
	return writer.swapToPreparedHeld()
}

func (writer *Writer) swapToPreparedHeld() error {
	marker, err := writer.markerWriter()
	if err != nil {
		return err
	}
	sealed := writer.handle
	startSeqNo := writer.highestAppended + 1
	durableSeqNo := max(writer.highestAppended, writer.highestDurable, marker.existingHighestSeen)
	key := SegmentKey(writer.config.IndexName, writer.config.PartitionID, startSeqNo)
	if err := sealed.Sync(); err != nil {
		return err
	}
	if err := writer.config.Directory.Move(PreparedKey(writer.config.IndexName, writer.config.PartitionID),
		key); err != nil {
		return err
	}
	handle, err := writer.config.Directory.OpenAppend(key)
	if err != nil {
		return err
	}
	writer.handle = handle
	writer.activeStartSeqNo = startSeqNo
	writer.activeBytes = wal.SegmentHeaderBytes
	writer.activeVersion = max(writer.preparedVersion, wal.FormatVersion)
	if err := marker.commit(startSeqNo, wal.SegmentHeaderBytes, durableSeqNo); err != nil {
		_ = sealed.Close()
		return err
	}
	writer.highestDurable = durableSeqNo
	writer.reportDurable()
	return sealed.Close()
}
