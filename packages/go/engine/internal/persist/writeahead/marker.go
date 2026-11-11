package writeahead

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/commitmarker"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type markerWriter struct {
	file                *storage.MarkerFile
	lastSlot            int
	written             bool
	writeSeq            uint64
	existingHighestSeen uint64
}

func openMarker(directory *storage.Directory, indexName string, partitionID uint32) (*markerWriter, error) {
	key := MarkerKey(indexName, partitionID)
	file, err := directory.OpenMarker(key)
	if err != nil {
		return nil, err
	}
	existing, err := file.Read(commitmarker.FileBytes)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	writer := &markerWriter{file: file}
	if slot, index, found := commitmarker.Decode(existing).Current(); found {
		writer.lastSlot = index
		writer.written = true
		writer.writeSeq = slot.WriteSeq
		writer.existingHighestSeen = slot.HighestDurableSeqNo
	}
	if file.Created() {
		if err := directory.SyncDirectoryOf(key); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
	return writer, nil
}

func (writer *markerWriter) commit(activeSegmentSeqNo, durableByteLength, highestDurableSeqNo uint64) error {
	slotIndex := commitmarker.NextSlot(writer.lastSlot, writer.written)
	slot := commitmarker.Slot{
		WriteSeq:            writer.writeSeq + 1,
		ActiveSegmentSeqNo:  activeSegmentSeqNo,
		DurableByteLength:   durableByteLength,
		HighestDurableSeqNo: highestDurableSeqNo,
	}
	encoded, err := commitmarker.AppendSlot(nil, slot)
	if err != nil {
		return err
	}
	if err := writer.file.WriteSlot(int64(commitmarker.SlotOffset(slotIndex)), encoded); err != nil {
		return err
	}
	writer.writeSeq++
	writer.lastSlot = slotIndex
	writer.written = true
	return nil
}

func (writer *markerWriter) close() error {
	return writer.file.Close()
}
