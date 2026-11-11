package commitmarker

import (
	"encoding/binary"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	SlotBytes = 36
	SlotCount = 2
	FileBytes = SlotBytes * SlotCount

	writeSeqOffset            = 0
	activeSegmentSeqNoOffset  = 8
	durableByteLengthOffset   = 16
	highestDurableSeqNoOffset = 24
	crcOffset                 = 32
)

type Slot struct {
	WriteSeq            uint64
	ActiveSegmentSeqNo  uint64
	DurableByteLength   uint64
	HighestDurableSeqNo uint64
}

type Marker struct {
	Slots [SlotCount]model.Optional[Slot]
}

func (slot Slot) withinSafeIntegers() bool {
	return slot.WriteSeq <= form.MaxSafeInteger && slot.ActiveSegmentSeqNo <= form.MaxSafeInteger &&
		slot.DurableByteLength <= form.MaxSafeInteger && slot.HighestDurableSeqNo <= form.MaxSafeInteger
}

func decodeSlot(data []byte, index int) model.Optional[Slot] {
	base := index * SlotBytes
	if base+SlotBytes > len(data) {
		return model.Optional[Slot]{}
	}
	encoded := data[base : base+SlotBytes]
	if codec.CRC32(encoded[:crcOffset]) != binary.BigEndian.Uint32(encoded[crcOffset:]) {
		return model.Optional[Slot]{}
	}
	slot := Slot{
		WriteSeq:            binary.BigEndian.Uint64(encoded[writeSeqOffset:]),
		ActiveSegmentSeqNo:  binary.BigEndian.Uint64(encoded[activeSegmentSeqNoOffset:]),
		DurableByteLength:   binary.BigEndian.Uint64(encoded[durableByteLengthOffset:]),
		HighestDurableSeqNo: binary.BigEndian.Uint64(encoded[highestDurableSeqNoOffset:]),
	}
	if !slot.withinSafeIntegers() {
		return model.Optional[Slot]{}
	}
	return model.Some(slot)
}

func Decode(data []byte) Marker {
	var marker Marker
	for index := range SlotCount {
		marker.Slots[index] = decodeSlot(data, index)
	}
	return marker
}

func (marker Marker) Current() (Slot, int, bool) {
	best := -1
	var chosen Slot
	for index, candidate := range marker.Slots {
		slot, valid := candidate.Get()
		if !valid {
			continue
		}
		if best < 0 || slot.WriteSeq > chosen.WriteSeq {
			best = index
			chosen = slot
		}
	}
	return chosen, best, best >= 0
}

func NextSlot(lastWritten int, written bool) int {
	if !written {
		return 0
	}
	return (lastWritten + 1) % SlotCount
}

func SlotOffset(index int) int {
	return index * SlotBytes
}

func AppendSlot(destination []byte, slot Slot) ([]byte, error) {
	if !slot.withinSafeIntegers() {
		return destination, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"A commit marker slot holds a value above 9007199254740991, which no reader accepts", nil)
	}
	start := len(destination)
	destination = append(destination, make([]byte, SlotBytes)...)
	encoded := destination[start:]
	binary.BigEndian.PutUint64(encoded[writeSeqOffset:], slot.WriteSeq)
	binary.BigEndian.PutUint64(encoded[activeSegmentSeqNoOffset:], slot.ActiveSegmentSeqNo)
	binary.BigEndian.PutUint64(encoded[durableByteLengthOffset:], slot.DurableByteLength)
	binary.BigEndian.PutUint64(encoded[highestDurableSeqNoOffset:], slot.HighestDurableSeqNo)
	binary.BigEndian.PutUint32(encoded[crcOffset:], codec.CRC32(encoded[:crcOffset]))
	return destination, nil
}

func Encode(marker Marker) ([]byte, error) {
	encoded := make([]byte, 0, FileBytes)
	for _, candidate := range marker.Slots {
		slot, valid := candidate.Get()
		if !valid {
			encoded = append(encoded, make([]byte, SlotBytes)...)
			continue
		}
		var err error
		if encoded, err = AppendSlot(encoded, slot); err != nil {
			return nil, err
		}
	}
	return encoded, nil
}
