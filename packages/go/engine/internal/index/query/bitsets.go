package query

import (
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
