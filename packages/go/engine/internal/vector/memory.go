package vector

import "unsafe"

const ordinalChunkBytes = int(unsafe.Sizeof(ordinalChunk{}))

func growthOf(region *growable, bytes uintptr) int {
	if region == nil || region.length >= bytes {
		return 0
	}
	return int(nextGrowthTarget(region.length, bytes, region.maxBytes) - region.length)
}

func blocksGrowth(blocks []*storeBlock, geometry blockGeometry, slots, last int) int {
	if geometry.capacity <= 0 {
		return 0
	}
	grown := 0
	for index := slots / geometry.capacity; index <= last/geometry.capacity; index++ {
		needed := min(last-index*geometry.capacity+1, geometry.capacity)
		bytes := geometry.slotsOffset + uintptr(needed)*geometry.slotStride
		if index < len(blocks) && blocks[index] != nil {
			grown += growthOf(blocks[index].memory, bytes)
			continue
		}
		initial := geometry.slotsOffset + uintptr(min(vectorBlockInitialSlots, geometry.capacity))*geometry.slotStride
		grown += int(max(bytes, initial))
	}
	return grown
}

func (s *storeMemory) memoryBytes() int {
	total := len(*s.table.chunks.Load())*ordinalChunkBytes + s.docIDBytes
	for _, region := range append(s.every(), s.head.header, s.head.centroid, s.head.codePresent) {
		total += int(region.length)
	}
	for _, block := range s.tables.vectorBlocks {
		if block != nil {
			total += int(block.memory.length)
		}
	}
	for _, block := range s.tables.codeBlocks {
		total += int(block.memory.length)
	}
	return total
}

func (s *storeMemory) growthBytesFor(vectors int) int {
	slots := int(s.slots())
	last := min(slots+max(0, vectors), MaxVectorOrdinals) - 1
	if last < slots {
		return 0
	}
	next := uintptr(last + 1)
	bytes := growthOf(s.magnitudes, next*8) + growthOf(s.present, next) + growthOf(s.head.codePresent, next) +
		growthOf(s.vectorFile, next*4) + growthOf(s.vectorOffset, next*4) + growthOf(s.born, next*8) +
		growthOf(s.retired, next*8)
	chunks := len(*s.table.chunks.Load())
	bytes += max(0, (last/ordinalChunkOrdinals+1)-chunks) * ordinalChunkBytes
	bytes += (last + 1 - slots) * s.longestDocID
	bytes += blocksGrowth(s.tables.vectorBlocks, s.vectorLayout, slots, last)
	if s.bits != 0 {
		bytes += blocksGrowth(s.tables.codeBlocks, s.codeLayout, slots, last)
	}
	return bytes
}

func (f *Field) EstimateMemoryBytes() int {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return 0
	}
	total := f.store.memoryBytes()
	if f.graph != nil {
		total += f.graph.bytes()
	}
	if f.fresh != nil {
		total += f.fresh.bytes()
	}
	if f.cold != nil {
		total += f.cold.field.ResidentBytes()
	}
	return total
}

func (f *Field) GrowthBytesFor(vectors int) int {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return 0
	}
	return f.store.growthBytesFor(vectors)
}

func (f *Field) Dispose() {
	f.builds.stop()
	f.writeMu.Lock()
	if f.disposed {
		f.writeMu.Unlock()
		return
	}
	f.disposed = true
	if f.builds.retry != nil {
		f.builds.retry.Stop()
		f.builds.retry = nil
	}
	f.cancelColdHold()
	idle := f.builds.idle
	f.writeMu.Unlock()
	<-idle
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	f.releaseHeldMemory()
	f.detachSlots()
}

func (f *Field) releaseHeldMemory() {
	if f.graph != nil {
		f.graph.resource.drop()
		f.graph = nil
	}
	if f.fresh != nil {
		f.fresh.resource.drop()
		f.fresh = nil
	}
	f.tombstones.forget()
	f.buffer.forget()
	clear(f.pendingLocations)
	f.savedFiles = nil
	f.savedSignature = nil
	previous := f.current.Swap(nil)
	if previous != nil {
		previous.retire()
	}
	f.store.discard()
}
