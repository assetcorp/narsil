package query

import (
	"math/bits"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func newBits(capacity uint32) []uint32 {
	return make([]uint32, bitsetWords(capacity))
}

func hasBit(words []uint32, ordinal uint32) bool {
	word := int(ordinal >> 5)
	return word < len(words) && words[word]&(1<<(ordinal&31)) != 0
}

func setBit(words []uint32, ordinal uint32) {
	if word := int(ordinal >> 5); word < len(words) {
		words[word] |= 1 << (ordinal & 31)
	}
}

func andBits(left, right []uint32) []uint32 {
	result := make([]uint32, min(len(left), len(right)))
	for at := range result {
		result[at] = left[at] & right[at]
	}
	return result
}

func notBits(words []uint32, capacity uint32) []uint32 {
	result := make([]uint32, len(words))
	full := int(capacity >> 5)
	for at := 0; at < full && at < len(words); at++ {
		result[at] = ^words[at]
	}
	if remainder := capacity & 31; remainder > 0 && full < len(words) {
		result[full] = ^words[full] & (1<<remainder - 1)
	}
	return result
}

func countBits(words []uint32) int {
	count := 0
	for _, word := range words {
		count += bits.OnesCount32(word)
	}
	return count
}

func eachBit(words []uint32, visit func(ordinal uint32)) {
	for at, word := range words {
		for word != 0 {
			visit(uint32(at)<<5 | uint32(bits.TrailingZeros32(word)))
			word &= word - 1
		}
	}
}

func (s *Segment) liveBits() ([]uint32, error) {
	capacity := s.capacity()
	if s.Live != nil {
		if len(s.Live) < bitsetWords(capacity) {
			return nil, narsilerr.New(narsilerr.CodePartitionCorrupted, "The live bitset of a segment is shorter than its ordinals", nil)
		}
		return s.Live[:bitsetWords(capacity)], nil
	}
	if s.Growing != nil {
		return nil, narsilerr.New(narsilerr.CodePartitionCorrupted, "A growing segment of the partition view holds no live bitset", nil)
	}
	live := newBits(capacity)
	for ordinal := range capacity {
		if !hasBit(s.State.Tombstones, ordinal) {
			setBit(live, ordinal)
		}
	}
	return live, nil
}

func presentOf(index core.FieldIndex, capacity uint32) []uint32 {
	present := newBits(capacity)
	switch typed := index.(type) {
	case *core.NumericIndex:
		if typed != nil {
			for _, ordinal := range typed.Ordinals {
				setBit(present, ordinal)
			}
		}
	case *core.BooleanIndex:
		if typed != nil {
			for at := range present {
				if at < len(typed.TrueBits) {
					present[at] |= typed.TrueBits[at]
				}
				if at < len(typed.FalseBits) {
					present[at] |= typed.FalseBits[at]
				}
			}
		}
	case *core.EnumIndex:
		if typed != nil {
			for _, ordinal := range typed.Postings {
				setBit(present, ordinal)
			}
		}
	case *core.GeoIndex:
		if typed != nil {
			for _, ordinal := range typed.Ordinals {
				setBit(present, ordinal)
			}
		}
	}
	return present
}
