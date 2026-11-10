package bitset

import "math/bits"

type Bits []uint32

func WordsFor(capacity int) int {
	if capacity <= 0 {
		return 1
	}
	return (capacity + 31) >> 5
}

func New(capacity int) Bits {
	return make(Bits, WordsFor(capacity))
}

func (b Bits) Has(ordinal uint32) bool {
	word := int(ordinal >> 5)
	if word >= len(b) {
		return false
	}
	return b[word]&(1<<(ordinal&31)) != 0
}

func (b Bits) Set(ordinal uint32) {
	word := int(ordinal >> 5)
	if word < len(b) {
		b[word] |= 1 << (ordinal & 31)
	}
}

func (b Bits) Clear(ordinal uint32) {
	word := int(ordinal >> 5)
	if word < len(b) {
		b[word] &^= 1 << (ordinal & 31)
	}
}

func (b Bits) Clone() Bits {
	return append(Bits(nil), b...)
}

func (b Bits) IsEmpty() bool {
	for _, word := range b {
		if word != 0 {
			return false
		}
	}
	return true
}

func (b Bits) Count() int {
	total := 0
	for _, word := range b {
		total += bits.OnesCount32(word)
	}
	return total
}

func (b Bits) AndWith(other Bits) {
	shared := min(len(b), len(other))
	for index := 0; index < shared; index++ {
		b[index] &= other[index]
	}
	clear(b[shared:])
}

func (b Bits) OrWith(other Bits) {
	shared := min(len(b), len(other))
	for index := 0; index < shared; index++ {
		b[index] |= other[index]
	}
}

func (b Bits) AndNotWith(removed Bits) {
	shared := min(len(b), len(removed))
	for index := 0; index < shared; index++ {
		b[index] &^= removed[index]
	}
}

func (b Bits) ForEach(visit func(ordinal uint32) bool) {
	for index, word := range b {
		base := uint32(index) << 5
		for word != 0 {
			low := uint32(bits.TrailingZeros32(word))
			if !visit(base + low) {
				return
			}
			word &= word - 1
		}
	}
}

func Grown(b Bits, ordinal uint32) Bits {
	word := int(ordinal >> 5)
	if word < len(b) {
		return b
	}
	grown := make(Bits, max(word+1, len(b)*2))
	copy(grown, b)
	return grown
}

func FromOrdinals(ordinals []uint32, capacity int) Bits {
	set := New(capacity)
	for _, ordinal := range ordinals {
		set.Set(ordinal)
	}
	return set
}
