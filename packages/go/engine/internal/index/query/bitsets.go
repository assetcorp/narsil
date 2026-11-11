package query

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func newBits(capacity uint32) []uint32 {
	return make([]uint32, bitsetWords(capacity))
}

func setBit(words []uint32, ordinal uint32) {
	if word := int(ordinal >> 5); word < len(words) {
		words[word] |= 1 << (ordinal & 31)
	}
}

func (s *Segment) liveBits() ([]uint32, error) {
	words := bitsetWords(s.capacity())
	if len(s.Live) < words {
		return nil, narsilerr.New(narsilerr.CodePartitionCorrupted, "The live bitset of a segment is shorter than its ordinals", nil)
	}
	return s.Live[:words], nil
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
