package fields

import "math/bits"

type presence struct {
	bits  array[uint32]
	words uint64
	stale bool
}

func bitsetWords(capacity uint32) uint64 {
	return max(1, (uint64(capacity)+bitsPerWord-1)/bitsPerWord)
}

func newPresence(name string, maxOrdinals uint32) presence {
	return presence{bits: newArray[uint32](name, bitsetWords(maxOrdinals)), stale: true}
}

func setBit(bits []uint32, ordinal uint32) {
	word := uint64(ordinal >> wordShift)
	if word < uint64(len(bits)) {
		bits[word] |= 1 << (ordinal & wordMask)
	}
}

func clearBit(bits []uint32, ordinal uint32) {
	word := uint64(ordinal >> wordShift)
	if word < uint64(len(bits)) {
		bits[word] &^= 1 << (ordinal & wordMask)
	}
}

func hasBit(bits []uint32, ordinal uint32) bool {
	word := uint64(ordinal >> wordShift)
	return word < uint64(len(bits)) && bits[word]&(1<<(ordinal&wordMask)) != 0
}

func (p *presence) invalidate() {
	p.stale = true
}

func (p *presence) rebuild(capacity uint32, fill func(bits []uint32)) error {
	words := bitsetWords(capacity)
	if !p.stale && p.words == words {
		return nil
	}
	if err := p.bits.reserve(words, 1); err != nil {
		return err
	}
	view := p.bits.prefix(words)
	clear(view)
	fill(view)
	p.words = words
	p.stale = false
	return nil
}

func (p *presence) view() []uint32 {
	return p.bits.prefix(p.words)
}

func (p *presence) bytes() uint64 {
	return p.bits.bytes()
}

func (p *presence) release() {
	p.bits.release()
	p.words = 0
	p.stale = true
}

func forEachBit(words []uint32, visit func(ordinal uint32)) {
	for at, word := range words {
		for word != 0 {
			visit(uint32(at)<<wordShift | uint32(bits.TrailingZeros32(word)))
			word &= word - 1
		}
	}
}
