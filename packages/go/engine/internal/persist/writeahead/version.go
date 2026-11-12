package writeahead

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

func versionNeededBy(entries []wal.Entry) uint8 {
	for _, entry := range entries {
		if entry.HoldsPreviousDocumentKey() {
			return wal.FormatVersionWithPreviousDocuments
		}
	}
	return wal.FormatVersion
}

func (writer *Writer) newSegmentVersion(needed uint8) uint8 {
	version := uint8(wal.FormatVersion)
	if writer.config.SegmentVersion != nil {
		version = writer.config.SegmentVersion()
	}
	return max(version, needed)
}

func (writer *Writer) reportDurable() {
	if writer.config.Durable != nil {
		writer.config.Durable()
	}
}

func segmentVersionOf(directory *storage.Directory, key string) (uint8, error) {
	header, err := directory.ReadPrefix(key, wal.SegmentHeaderBytes)
	if err != nil {
		return 0, err
	}
	return wal.CheckSegmentHeader(header)
}

func (writer *Writer) raiseActiveVersionHeld(nextSeqNo uint64, needed uint8) error {
	if writer.activeVersion >= needed {
		return nil
	}
	if writer.activeBytes > wal.SegmentHeaderBytes {
		return writer.rollHeld(nextSeqNo, needed)
	}
	return writer.replaceEmptyActiveHeld(needed)
}

func (writer *Writer) replaceEmptyActiveHeld(version uint8) error {
	key := writer.handle.Key()
	handle := writer.handle
	writer.handle = nil
	if err := handle.Close(); err != nil {
		return err
	}
	writer.nextSegmentPrepared = false
	preparedKey := PreparedKey(writer.config.IndexName, writer.config.PartitionID)
	prepared, err := writer.config.Directory.OpenAppend(preparedKey)
	if err != nil {
		return err
	}
	err = writeEmptySegment(prepared, version)
	if closeErr := prepared.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := writer.config.Directory.Move(preparedKey, key); err != nil {
		return err
	}
	_, err = writer.openSegmentHeld(key, version)
	return err
}

func writeEmptySegment(file *storage.AppendFile, version uint8) error {
	size, err := file.Size()
	if err != nil {
		return err
	}
	if size > 0 {
		if err := file.Truncate(0); err != nil {
			return err
		}
	}
	if err := file.Append(wal.AppendSegmentHeaderOfVersion(nil, version)); err != nil {
		return err
	}
	return file.Sync()
}
