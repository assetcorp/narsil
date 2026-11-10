package vector

import (
	"sync/atomic"
	"unsafe"
)

const (
	ordinalHoldsDocument uint32 = 1 << iota
	ordinalRemoved
	ordinalUnplaced
	ordinalReplaced
	ordinalPinned
)

const (
	unknownPartition int32 = -1
	noPartition      int32 = -2
)

type ordinalChunk struct {
	docIDs     [ordinalChunkOrdinals]string
	flags      [ordinalChunkOrdinals]atomic.Uint32
	partitions [ordinalChunkOrdinals]atomic.Int32
	unplaced   atomic.Int32
}

func (t *ordinalTable) markUnplaced(ordinal int32, unplaced bool) {
	chunk := t.chunkOf(ordinal)
	if chunk == nil {
		return
	}
	word := &chunk.flags[int(ordinal)%ordinalChunkOrdinals]
	held := word.Load()&ordinalUnplaced != 0
	if held == unplaced {
		return
	}
	if unplaced {
		word.Or(ordinalUnplaced)
		chunk.unplaced.Add(1)
		return
	}
	word.And(^ordinalUnplaced)
	chunk.unplaced.Add(-1)
}

func (t *ordinalTable) eachUnplaced(visit func(ordinal int32) bool) {
	chunks := *t.chunks.Load()
	slots := t.slots.Load()
	for index, chunk := range chunks {
		if chunk.unplaced.Load() == 0 {
			continue
		}
		first := int32(index * ordinalChunkOrdinals)
		for position := range ordinalChunkOrdinals {
			ordinal := first + int32(position)
			if ordinal >= slots {
				return
			}
			if chunk.flags[position].Load()&ordinalUnplaced != 0 && !visit(ordinal) {
				return
			}
		}
	}
}

type ordinalTable struct {
	chunks atomic.Pointer[[]*ordinalChunk]
	slots  atomic.Int32
}

func newOrdinalTable() *ordinalTable {
	table := &ordinalTable{}
	empty := []*ordinalChunk{}
	table.chunks.Store(&empty)
	return table
}

func (t *ordinalTable) chunkOf(ordinal int32) *ordinalChunk {
	chunks := *t.chunks.Load()
	index := int(ordinal) / ordinalChunkOrdinals
	if ordinal < 0 || index >= len(chunks) {
		return nil
	}
	return chunks[index]
}

func (t *ordinalTable) reserve(ordinal int32) {
	chunks := *t.chunks.Load()
	needed := int(ordinal)/ordinalChunkOrdinals + 1
	if needed <= len(chunks) {
		return
	}
	grown := make([]*ordinalChunk, needed)
	copy(grown, chunks)
	for index := len(chunks); index < needed; index++ {
		grown[index] = &ordinalChunk{}
	}
	t.chunks.Store(&grown)
}

func (t *ordinalTable) docID(ordinal int32) (string, bool) {
	if ordinal < 0 || ordinal >= t.slots.Load() {
		return "", false
	}
	chunk := t.chunkOf(ordinal)
	if chunk == nil {
		return "", false
	}
	position := int(ordinal) % ordinalChunkOrdinals
	if chunk.flags[position].Load()&ordinalHoldsDocument == 0 {
		return "", false
	}
	return chunk.docIDs[position], true
}

func (t *ordinalTable) storedDocID(ordinal int32) string {
	chunk := t.chunkOf(ordinal)
	if chunk == nil {
		return ""
	}
	return chunk.docIDs[int(ordinal)%ordinalChunkOrdinals]
}

func (t *ordinalTable) flags(ordinal int32) uint32 {
	chunk := t.chunkOf(ordinal)
	if chunk == nil {
		return 0
	}
	return chunk.flags[int(ordinal)%ordinalChunkOrdinals].Load()
}

func (t *ordinalTable) setFlag(ordinal int32, flag uint32) {
	if chunk := t.chunkOf(ordinal); chunk != nil {
		chunk.flags[int(ordinal)%ordinalChunkOrdinals].Or(flag)
	}
}

func (t *ordinalTable) clearFlag(ordinal int32, flag uint32) {
	if chunk := t.chunkOf(ordinal); chunk != nil {
		chunk.flags[int(ordinal)%ordinalChunkOrdinals].And(^flag)
	}
}

func (t *ordinalTable) partition(ordinal int32) int32 {
	chunk := t.chunkOf(ordinal)
	if chunk == nil {
		return noPartition
	}
	return chunk.partitions[int(ordinal)%ordinalChunkOrdinals].Load()
}

func (t *ordinalTable) setPartition(ordinal, partition int32) {
	if chunk := t.chunkOf(ordinal); chunk != nil {
		chunk.partitions[int(ordinal)%ordinalChunkOrdinals].Store(partition)
	}
}

func (t *ordinalTable) write(ordinal int32, docID string, flags uint32, partition int32) {
	t.reserve(ordinal)
	chunk := t.chunkOf(ordinal)
	position := int(ordinal) % ordinalChunkOrdinals
	chunk.docIDs[position] = docID
	chunk.partitions[position].Store(partition)
	chunk.flags[position].Store(flags)
}

func storeByte(base unsafe.Pointer, index int, value byte) {
	address := uintptr(base) + uintptr(index)
	aligned := address &^ 3
	shift := (address - aligned) * 8
	word := (*atomic.Uint32)(unsafe.Add(base, int(aligned-uintptr(base))))
	mask := uint32(0xff) << shift
	for {
		seen := word.Load()
		next := (seen &^ mask) | uint32(value)<<shift
		if seen == next || word.CompareAndSwap(seen, next) {
			return
		}
	}
}

func loadByte(base unsafe.Pointer, index int) byte {
	address := uintptr(base) + uintptr(index)
	aligned := address &^ 3
	shift := (address - aligned) * 8
	word := (*atomic.Uint32)(unsafe.Add(base, int(aligned-uintptr(base))))
	return byte(word.Load() >> shift)
}
