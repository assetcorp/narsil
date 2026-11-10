package postings

import "math"

const noPositions = math.MaxUint32

type pool struct {
	docIDs         []uint32
	frequencies    []uint16
	fields         []uint16
	positionStarts []uint32
	end            uint32
	free           [sliceClassCount][]uint32
	freeEntries    int
}

func sliceCapacity(class uint8) uint32 {
	if class == noSlice {
		return 0
	}
	return firstSliceCapacity << class
}

func sliceClassFor(needed uint32) uint8 {
	class := uint8(0)
	for sliceCapacity(class) < needed && class < sliceClassCount-1 {
		class++
	}
	return class
}

func (p *pool) tracksPositions() bool {
	return p.positionStarts != nil
}

func (p *pool) trackPositions() {
	if p.positionStarts == nil {
		p.positionStarts = make([]uint32, len(p.docIDs), cap(p.docIDs))
		for index := range p.positionStarts {
			p.positionStarts[index] = noPositions
		}
	}
}

func (p *pool) allocate(class uint8) uint32 {
	if held := p.free[class]; len(held) > 0 {
		start := held[len(held)-1]
		p.free[class] = held[:len(held)-1]
		p.freeEntries -= int(sliceCapacity(class))
		return start
	}
	start := p.end
	grownEnd := int(start) + int(sliceCapacity(class))
	p.docIDs = grownTo(p.docIDs, grownEnd)
	p.frequencies = grownTo(p.frequencies, grownEnd)
	p.fields = grownTo(p.fields, grownEnd)
	if p.positionStarts != nil {
		before := len(p.positionStarts)
		p.positionStarts = grownTo(p.positionStarts, grownEnd)
		for index := before; index < grownEnd; index++ {
			p.positionStarts[index] = noPositions
		}
	}
	p.end = uint32(grownEnd)
	return start
}

func grownTo[Value uint16 | uint32](values []Value, length int) []Value {
	if length <= len(values) {
		return values
	}
	if length <= cap(values) {
		return values[:length]
	}
	grown := make([]Value, length, max(length, cap(values)+cap(values)/2))
	copy(grown, values)
	return grown
}

func (p *pool) release(start uint32, class uint8) {
	if class == noSlice {
		return
	}
	p.free[class] = append(p.free[class], start)
	p.freeEntries += int(sliceCapacity(class))
}

func (p *pool) move(from, to, length uint32) {
	copy(p.docIDs[to:to+length], p.docIDs[from:from+length])
	copy(p.frequencies[to:to+length], p.frequencies[from:from+length])
	copy(p.fields[to:to+length], p.fields[from:from+length])
	if p.positionStarts != nil {
		copy(p.positionStarts[to:to+length], p.positionStarts[from:from+length])
	}
}

func (p *pool) estimateBytes() int {
	bytes := cap(p.docIDs)*4 + cap(p.frequencies)*2 + cap(p.fields)*2 + cap(p.positionStarts)*4
	for _, held := range p.free {
		bytes += cap(held) * 4
	}
	return bytes
}

type positionPool struct {
	values []uint32
	free   int
}

func (p *positionPool) append(positions []uint32) uint32 {
	start := uint32(len(p.values))
	p.values = append(p.values, uint32(len(positions)))
	p.values = append(p.values, positions...)
	return start
}

func (p *positionPool) release(start uint32) {
	if start == noPositions || int(start) >= len(p.values) {
		return
	}
	p.free += int(p.values[start]) + 1
}

func (p *positionPool) read(start uint32) []uint32 {
	if start == noPositions || int(start) >= len(p.values) {
		return nil
	}
	count := p.values[start]
	end := int(start) + 1 + int(count)
	if end > len(p.values) {
		return nil
	}
	return p.values[start+1 : end : end]
}

func (p *positionPool) sparse() bool {
	return p.free >= positionVacuumMinFreeValues && float64(p.free) > float64(len(p.values))*poolVacuumFreeFraction
}
