package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/growing"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type generation struct {
	documents *documentTable
}

func newGeneration() *generation {
	return &generation{documents: newDocumentTable()}
}

type fieldTable struct {
	names   []string
	numbers map[string]uint16
	partial map[string]bool
}

func newFieldTable(partialFields []string) *fieldTable {
	partial := make(map[string]bool, len(partialFields))
	for _, path := range partialFields {
		partial[path] = true
	}
	return &fieldTable{numbers: map[string]uint16{}, partial: partial}
}

func (t *fieldTable) number(path string) uint16 {
	if number, held := t.numbers[path]; held {
		return number
	}
	number := uint16(len(t.names))
	t.names = append(t.names, path)
	t.numbers[path] = number
	return number
}

type frozenSide struct {
	segment *frozenSegment
	state   *segments.State
	totals  []float64
}

type side struct {
	index      int
	view       *query.View
	gen        *generation
	names      *fieldTable
	viewFields int
	fieldCount int
	growing    *growing.Segment
	fields     *fields.Set
	ids        map[string]uint32
	live       []uint32
	liveCount  int
	capacity   uint32
	frozen     []frozenSide
}

func (p *Partition) newSide(index int, gen *generation) (*side, error) {
	segment, err := growing.New(growing.Options{TrackPositions: p.settings.TrackPositions, PartialFields: len(p.names.partial) > 0})
	if err != nil {
		return nil, err
	}
	set, err := fields.NewSet(p.settings.ValueFields, p.settings.Limits)
	if err != nil {
		segment.Release()
		return nil, err
	}
	return &side{index: index, gen: gen, names: p.names, growing: segment, fields: set, ids: map[string]uint32{}}, nil
}

func (s *side) release() {
	s.growing.Release()
	s.fields.Release()
}

func (s *side) holdsLive(ordinal uint32) bool {
	word := ordinal >> 5
	return int(word) < len(s.live) && s.live[word]&(1<<(ordinal&31)) != 0
}

func (s *side) setLive(ordinal uint32) {
	word := int(ordinal >> 5)
	for word >= len(s.live) {
		s.live = append(s.live, 0)
	}
	if s.live[word]&(1<<(ordinal&31)) == 0 {
		s.live[word] |= 1 << (ordinal & 31)
		s.liveCount++
	}
}

func (s *side) clearLive(ordinal uint32) {
	if s.holdsLive(ordinal) {
		s.live[ordinal>>5] &^= 1 << (ordinal & 31)
		s.liveCount--
	}
}

func (s *side) widenFields(count int) error {
	if count <= s.fieldCount {
		return nil
	}
	if err := s.growing.ReserveFields(s.capacity, count); err != nil {
		return err
	}
	for field := s.fieldCount; field < count; field++ {
		if err := s.growing.SetPartial(field, s.names.partial[s.names.names[field]]); err != nil {
			return err
		}
	}
	s.fieldCount = count
	s.viewFields = max(s.viewFields, count)
	return nil
}

func (s *side) widenOrdinals(ordinal uint32) error {
	if err := s.growing.ReserveFields(ordinal+1, s.fieldCount); err != nil {
		return err
	}
	s.capacity = max(s.capacity, ordinal+1)
	return nil
}

type location struct {
	frozen  int
	ordinal uint32
	found   bool
}

func (s *side) locate(id string) location {
	if ordinal, held := s.ids[id]; held {
		return location{frozen: -1, ordinal: ordinal, found: true}
	}
	for at := len(s.frozen) - 1; at >= 0; at-- {
		held := s.frozen[at]
		if ordinal, found := held.segment.ordinalOf(id); found && !held.state.Tombstoned(ordinal) {
			return location{frozen: at, ordinal: ordinal, found: true}
		}
	}
	return location{}
}

func (s *side) document(at location) (storedDocument, bool, error) {
	if !at.found {
		return storedDocument{}, false, nil
	}
	if at.frozen < 0 {
		document, held := s.gen.documents.at(s.index, at.ordinal)
		return document, held, nil
	}
	return s.frozen[at.frozen].segment.documentAt(at.ordinal)
}

func (s *side) documentCount() int {
	count := s.liveCount
	for _, held := range s.frozen {
		count += int(held.segment.documentCount()) - int(held.state.Core.TombstoneCount[0])
	}
	return count
}
