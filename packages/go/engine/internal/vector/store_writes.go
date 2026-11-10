package vector

import (
	"math"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type diskLocation struct {
	fileIndex int32
	offset    uint32
}

func magnitudeOf(values []float32) float64 {
	var lanes [4]float32
	simdEnd := len(values) &^ 3
	index := 0
	for ; index < simdEnd; index += 4 {
		for lane := range 4 {
			value := values[index+lane]
			lanes[lane] = lanes[lane] + float32(value*value)
		}
	}
	sum := float32(lanes[0]+lanes[1]) + float32(lanes[2]+lanes[3])
	for ; index < len(values); index++ {
		value := values[index]
		sum = sum + float32(value*value)
	}
	return float64(float32(math.Sqrt(float64(sum))))
}

func (s *storeMemory) ensureCodeSlot(ordinal int32) (bool, error) {
	if s.bits == 0 {
		return false, nil
	}
	index := int(ordinal) / s.codeLayout.capacity
	changed := false
	if len(s.tables.codeBlocks) <= index {
		next := s.tables.clone()
		for len(next.codeBlocks) <= index {
			block, err := newStoreBlock(s.codeLayout)
			if err != nil {
				return false, err
			}
			next.codeBlocks = append(next.codeBlocks, block)
		}
		s.tables = next
		s.word(storeWordCodeBlockCount).Store(int32(len(next.codeBlocks)))
		changed = true
	}
	return changed, s.tables.codeBlocks[index].ensureSlots(s.codeLayout, int(ordinal)%s.codeLayout.capacity+1)
}

func (s *storeMemory) ensureFloatSlot(ordinal int32) (bool, error) {
	index := int(ordinal) / s.vectorLayout.capacity
	if index >= len(s.tables.vectorBlocks) || s.tables.vectorBlocks[index] == nil {
		next := s.tables.clone()
		for len(next.vectorBlocks) <= index {
			next.vectorBlocks = append(next.vectorBlocks, nil)
		}
		block, err := newStoreBlock(s.vectorLayout)
		if err != nil {
			return false, err
		}
		next.vectorBlocks[index] = block
		s.tables = next
		s.word(storeWordBlockCount).Store(int32(len(next.vectorBlocks)))
		return true, block.ensureSlots(s.vectorLayout, int(ordinal)%s.vectorLayout.capacity+1)
	}
	return false, s.tables.vectorBlocks[index].ensureSlots(s.vectorLayout, int(ordinal)%s.vectorLayout.capacity+1)
}

func (s *storeMemory) ensureOrdinal(ordinal int32, cold bool) (bool, error) {
	if ordinal >= MaxVectorOrdinals {
		return false, capacityExceeded(ordinal)
	}
	next := uintptr(ordinal) + 1
	growths := []struct {
		region *growable
		bytes  uintptr
	}{
		{s.magnitudes, next * 8}, {s.present, next}, {s.head.codePresent, next}, {s.vectorOffset, next * 4},
	}
	for _, growth := range growths {
		if err := growth.region.growTo(growth.bytes); err != nil {
			return false, err
		}
	}
	held := s.vectorFile.length
	if err := s.vectorFile.growTo(next * 4); err != nil {
		return false, err
	}
	if s.vectorFile.length > held {
		s.fillInMemory(held)
	}
	s.table.reserve(ordinal)
	changed := false
	if !cold {
		grew, err := s.ensureFloatSlot(ordinal)
		if err != nil {
			return grew, err
		}
		changed = grew
	}
	grew, err := s.ensureCodeSlot(ordinal)
	return changed || grew, err
}

func (s *storeMemory) claimSlot(docID string, cold bool) (int32, bool, error) {
	ordinal := s.slots()
	changed, err := s.ensureOrdinal(ordinal, cold)
	if err != nil {
		return 0, changed, err
	}
	int32Word(s.vectorFile.pointer(), int(ordinal)).Store(vectorInMemory)
	s.docIDBytes += len(docID)
	s.longestDocID = max(s.longestDocID, len(docID))
	s.word(storeWordDocIDBytes).Store(int32(min(s.docIDBytes, math.MaxInt32)))
	return ordinal, changed, nil
}

func (s *storeMemory) givenPartition(partition int32) int32 {
	if partition >= 0 {
		return partition
	}
	s.unknownParts++
	return unknownPartition
}

func (s *storeMemory) writeVector(ordinal int32, values []float32) {
	copy(s.vectorSlot(s.tables, ordinal), values)
	*float64Slot(s.magnitudes.pointer(), int(ordinal)) = magnitudeOf(values)
}

func (s *storeMemory) publishOrdinal(ordinal int32) {
	s.word(core.StoreWordSlots).Store(ordinal + 1)
	s.table.slots.Store(ordinal + 1)
	storeByte(s.present.pointer(), int(ordinal), 1)
}

func (s *storeMemory) appendOrdinal(docID string, values []float32, partition int32) (int32, bool, error) {
	ordinal, changed, err := s.claimSlot(docID, false)
	if err != nil {
		return 0, changed, err
	}
	s.writeVector(ordinal, values)
	s.table.write(ordinal, docID, ordinalHoldsDocument, s.givenPartition(partition))
	s.publishOrdinal(ordinal)
	s.byDocID.Store(docID, ordinal)
	return ordinal, changed, nil
}

func (s *storeMemory) settleReplacement(previous int32, hadPrevious, keepsReplaced bool) {
	if !hadPrevious {
		s.liveCount.Add(1)
		s.word(core.StoreWordLiveCount).Add(1)
		return
	}
	if keepsReplaced {
		s.keepReplacedOrdinal(previous)
		return
	}
	s.retireOrdinal(previous)
}

func (s *storeMemory) insert(docID string, values []float32, partition int32, keepsReplaced bool) (int32, bool, error) {
	previous, hadPrevious := s.ordinalOf(docID)
	ordinal, changed, err := s.appendOrdinal(docID, values, partition)
	if err != nil {
		return 0, changed, err
	}
	s.settleReplacement(previous, hadPrevious, keepsReplaced)
	return ordinal, changed, nil
}

func (s *storeMemory) forgetPartitionOf(ordinal int32) {
	if s.table.partition(ordinal) == unknownPartition {
		s.unknownParts--
	}
}

func (s *storeMemory) retireOrdinal(ordinal int32) {
	s.table.clearFlag(ordinal, ordinalHoldsDocument)
	storeByte(s.present.pointer(), int(ordinal), 0)
	s.pins.note(ordinal)
	s.forgetPartitionOf(ordinal)
}

func (s *storeMemory) keepReplacedOrdinal(ordinal int32) {
	s.table.clearFlag(ordinal, ordinalHoldsDocument)
	s.forgetPartitionOf(ordinal)
	s.table.setPartition(ordinal, noPartition)
	s.table.setFlag(ordinal, ordinalReplaced)
	s.replaced[ordinal] = struct{}{}
}

func (s *storeMemory) remove(docID string) {
	ordinal, ok := s.ordinalOf(docID)
	if !ok {
		return
	}
	s.byDocID.Delete(docID)
	s.retireOrdinal(ordinal)
	s.liveCount.Add(-1)
	s.word(core.StoreWordLiveCount).Add(-1)
}

func (s *storeMemory) releaseReplacedVectors() []int32 {
	released := make([]int32, 0, len(s.replaced))
	for ordinal := range s.replaced {
		released = append(released, ordinal)
	}
	clear(s.replaced)
	for _, ordinal := range released {
		s.table.clearFlag(ordinal, ordinalReplaced)
		s.pins.note(ordinal)
		storeByte(s.present.pointer(), int(ordinal), 0)
	}
	return released
}

func (s *storeMemory) publishOnDisk(ordinal int32, magnitude float64, location diskLocation) {
	*float64Slot(s.magnitudes.pointer(), int(ordinal)) = magnitude
	uint32Word(s.vectorOffset.pointer(), int(ordinal)).Store(location.offset)
	int32Word(s.vectorFile.pointer(), int(ordinal)).Store(location.fileIndex)
	s.publishOrdinal(ordinal)
}

func (s *storeMemory) insertCold(docID string, magnitude float64, location diskLocation, partition int32) (int32, bool, error) {
	previous, hadPrevious := s.ordinalOf(docID)
	s.word(storeWordReleasedVectorsToDisk).Store(1)
	ordinal, changed, err := s.claimSlot(docID, true)
	if err != nil {
		return 0, changed, err
	}
	s.table.write(ordinal, docID, ordinalHoldsDocument, s.givenPartition(partition))
	s.publishOnDisk(ordinal, magnitude, location)
	s.byDocID.Store(docID, ordinal)
	s.settleReplacement(previous, hadPrevious, false)
	return ordinal, changed, nil
}

func (s *storeMemory) insertReplaced(docID string, values []float32, location *diskLocation) (int32, bool, error) {
	cold := location != nil
	if cold {
		s.word(storeWordReleasedVectorsToDisk).Store(1)
	}
	ordinal, changed, err := s.claimSlot(docID, cold)
	if err != nil {
		return 0, changed, err
	}
	s.table.write(ordinal, docID, ordinalReplaced, noPartition)
	s.replaced[ordinal] = struct{}{}
	if cold {
		s.publishOnDisk(ordinal, magnitudeOf(values), *location)
		return ordinal, changed, nil
	}
	s.writeVector(ordinal, values)
	s.publishOrdinal(ordinal)
	return ordinal, changed, nil
}

func (s *storeMemory) setPartition(docID string, partition int32) {
	ordinal, ok := s.ordinalOf(docID)
	if !ok || partition < 0 {
		return
	}
	s.forgetPartitionOf(ordinal)
	s.table.setPartition(ordinal, partition)
}

func (s *storeMemory) forgetPartition(docID string) {
	ordinal, ok := s.ordinalOf(docID)
	if !ok {
		return
	}
	s.forgetPartitionOf(ordinal)
	s.table.setPartition(ordinal, noPartition)
}

func (s *storeMemory) partitionOf(ordinal int32) (int32, bool) {
	if ordinal < 0 || ordinal >= s.slots() {
		return 0, false
	}
	partition := s.table.partition(ordinal)
	return partition, partition >= 0
}

func (s *storeMemory) readable(ordinal int32) bool {
	return s.table.flags(ordinal)&(ordinalHoldsDocument|ordinalReplaced) != 0
}

func (s *storeMemory) vectorFromFile(tables *storeTables, ordinal int32, target []float32) bool {
	position := int(s.vectorFileOf(ordinal))
	files := tables.files
	if position < 0 || position >= len(files) || files[position] == nil || files[position].mapped == nil {
		return false
	}
	bytes := files[position].mapped.Bytes()
	offset := int(uint32Word(s.vectorOffset.pointer(), int(ordinal)).Load())
	length := s.dimension * 4
	if offset < 0 || offset+length > len(bytes) || len(target) < s.dimension {
		return false
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(unsafe.SliceData(target))), length), bytes[offset:offset+length])
	return true
}

func (s *storeMemory) readVector(tables *storeTables, ordinal int32, target []float32) bool {
	return s.readable(ordinal) && s.readStoredVector(tables, ordinal, target)
}
