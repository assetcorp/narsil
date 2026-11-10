package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
)

type Sub struct {
	tail    *side
	frozen  *frozenSub
	base    uint32
	words   int
	failure *readFailure
}

func (v View) Subs() []Sub {
	if !v.HoldsFrozenSegments() {
		return []Sub{{tail: v.state, words: bitset.WordsFor(int(v.state.documents.capacity())), failure: v.failure}}
	}
	layout := v.layout()
	subs := make([]Sub, 0, len(v.state.frozen)+1)
	for at, held := range v.state.frozen {
		start, end := layout.words(at)
		subs = append(subs, Sub{frozen: held, base: layout.bases[at], words: end - start, failure: v.failure})
	}
	last := len(layout.bases) - 1
	start, end := layout.words(last)
	return append(subs, Sub{tail: v.state, base: layout.bases[last], words: end - start, failure: v.failure})
}

func (s Sub) source() keywordSource {
	if s.frozen != nil {
		return s.frozen
	}
	return s.tail
}

func (s Sub) Base() uint32 {
	return s.base
}

func (s Sub) Of(bits bitset.Bits) bitset.Bits {
	start := min(int(s.base>>5), len(bits))
	end := min(start+s.words, len(bits))
	return bits[start:end:end]
}

func (s Sub) PlaceInto(into, sub bitset.Bits) {
	start := int(s.base >> 5)
	if start >= len(into) {
		return
	}
	copy(into[start:min(start+s.words, len(into))], sub)
}

func (s Sub) Segment() *frozen.Segment {
	if s.frozen == nil {
		return nil
	}
	return s.frozen.segment
}

func (s Sub) LiveSurfaces() []frozen.SurfaceForm {
	if s.frozen == nil {
		return nil
	}
	return s.frozen.liveSurfaces()
}

func (s Sub) Tombstones() []uint32 {
	if s.frozen == nil {
		return nil
	}
	return append([]uint32(nil), s.frozen.arrivals...)
}

func (s Sub) OrdinalCapacity() int {
	return int(s.source().ordinalCapacity())
}

func (s Sub) Capacity() int {
	return s.OrdinalCapacity()
}

func (s Sub) Live() bitset.Bits {
	return s.source().liveBits()
}

func (s Sub) Count() int {
	return s.source().documentCount()
}

func (s Sub) DocumentAt(ordinal uint32) *StoredDocument {
	if ordinal >= s.source().ordinalCapacity() {
		return nil
	}
	document, err := s.source().documentAt(ordinal)
	if err != nil {
		s.failure.record(err)
		return nil
	}
	return document
}

func (s Sub) IDAt(ordinal uint32) (string, bool) {
	if ordinal >= s.source().ordinalCapacity() {
		return "", false
	}
	return s.source().idAt(ordinal)
}

func (s Sub) StoredDocument(ordinal uint32) (map[string]any, bool) {
	document := s.DocumentAt(ordinal)
	if document == nil {
		return nil, false
	}
	return document.Fields, true
}

func (s Sub) OrdinalOf(id string) (uint32, bool) {
	if s.frozen != nil {
		return s.frozen.holdsLive(id)
	}
	_, ordinal, found := s.tail.documents.get(id)
	return ordinal, found
}

func (s Sub) indexes() frozen.FieldIndexes {
	if s.frozen != nil {
		return s.frozen.segment.Indexes()
	}
	return frozen.FieldIndexes{Numbers: s.tail.numbers, Booleans: s.tail.booleans, Enums: s.tail.enums, Geopoints: s.tail.geopoints, Sizes: s.tail.sizes}
}

func (s Sub) NumericIndex(path string) *fieldindex.Numeric {
	return s.indexes().Numbers[path]
}

func (s Sub) BooleanIndex(path string) *fieldindex.Boolean {
	return s.indexes().Booleans[path]
}

func (s Sub) EnumIndex(path string) *fieldindex.Enum {
	return s.indexes().Enums[path]
}

func (s Sub) Geopoint(path string) *geo.Index {
	return s.indexes().Geopoints[path]
}

func (s Sub) ValueSizes(path string) *fieldindex.Numeric {
	return s.indexes().Sizes[path]
}

func (s Sub) PatternIndex(path string) (pattern.Reader, bool) {
	if s.frozen != nil {
		index, found := s.frozen.segment.PatternIndex(path)
		return index, found
	}
	index, found := s.tail.patterns[path]
	return index, found
}
