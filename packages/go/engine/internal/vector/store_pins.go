package vector

import (
	"sync/atomic"
	"unsafe"
)

const storeWordWriteSequence = 12

func sequenceWord(region *growable, ordinal int32) *atomic.Int64 {
	return (*atomic.Int64)(unsafe.Add(region.pointer(), uintptr(ordinal)*8))
}

func (s *storeMemory) writeSequence() *atomic.Int64 {
	return (*atomic.Int64)(unsafe.Add(s.head.header.pointer(), storeWordWriteSequence*4))
}

func (s *storeMemory) bornAt(ordinal int32) int64 {
	return sequenceWord(s.born, ordinal).Load()
}

func (s *storeMemory) retiredAt(ordinal int32) int64 {
	return sequenceWord(s.retired, ordinal).Load()
}

func (s *storeMemory) stampBorn(ordinal int32, sequence int64) {
	sequenceWord(s.born, ordinal).Store(sequence)
}

func (s *storeMemory) stampRetired(ordinal int32, sequence int64) {
	sequenceWord(s.retired, ordinal).CompareAndSwap(0, sequence)
}

func (s *storeMemory) admits(ordinal int32, pin int64) bool {
	if ordinal < 0 || ordinal >= s.slots() {
		return false
	}
	if retired := s.retiredAt(ordinal); retired != 0 && retired <= pin {
		return false
	}
	born := s.bornAt(ordinal)
	return born != 0 && born <= pin
}

func (s *storeMemory) freeable(ordinal int32, oldestPin int64) bool {
	if ordinal < 0 || ordinal >= s.slots() {
		return false
	}
	retired := s.retiredAt(ordinal)
	return retired > 0 && retired <= oldestPin
}

func (s *storeMemory) admittedOrdinalOf(docID string, pin int64) (int32, bool) {
	ordinal, held := s.ordinalOf(docID)
	for held && ordinal >= 0 {
		if s.admits(ordinal, pin) {
			return ordinal, true
		}
		ordinal, held = s.table.previous(ordinal)
	}
	return 0, false
}

func (s *storeMemory) publishSequence(sequence int64) {
	word := s.writeSequence()
	for {
		seen := word.Load()
		if seen >= sequence || word.CompareAndSwap(seen, sequence) {
			return
		}
	}
}

func (s *storeMemory) readStoredVector(tables *storeTables, ordinal int32, target []float32) bool {
	if ordinal < 0 || ordinal >= s.slots() || len(target) < s.dimension {
		return false
	}
	if s.isCold(ordinal) {
		return s.vectorFromFile(tables, ordinal, target)
	}
	slot := s.vectorSlot(tables, ordinal)
	if slot == nil {
		return false
	}
	copy(target, slot)
	return true
}

func (s *storeMemory) holdFreedVectors() {
	s.freedHolds++
}

func (s *storeMemory) releaseFreedVectors() {
	if s.freedHolds == 0 {
		return
	}
	s.freedHolds--
	if s.freedHolds == 0 {
		clear(s.freedHeld)
	}
}

func (s *storeMemory) noteFreed(ordinal int32) {
	if s.freedHolds > 0 {
		s.freedHeld[ordinal] = struct{}{}
	}
}

func (s *storeMemory) keepsFreedVector(ordinal int32) bool {
	_, kept := s.freedHeld[ordinal]
	return kept
}

func (s *storeMemory) readPinnedVector(ordinal int32, target []float32) bool {
	return (s.holdsVector(ordinal) || s.keepsFreedVector(ordinal)) && s.readStoredVector(s.tables, ordinal, target)
}
