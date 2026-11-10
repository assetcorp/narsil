package query

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type FrozenPositions struct {
	Offsets []uint32
	Values  []uint32
}

type SortColumnKey struct {
	Field string
	Mode  core.SortMode
}

type FieldIndexes struct {
	Numeric map[string]*core.NumericIndex
	Size    map[string]*core.NumericIndex
	Boolean map[string]*core.BooleanIndex
	Enum    map[string]*core.EnumIndex
	Geo     map[string]*core.GeoIndex
	Pattern map[string]*core.PatternIndex
	Stored  map[string]*core.StoredValueSlices
	Sort    map[SortColumnKey]*core.SortColumn
	Present map[string][]uint32
}

type PagedPostings interface {
	ReadPostings(w *core.Workspace, term uint32, output []byte) (int, error)
	TermTotals() ([]float64, error)
	ReadPositions(term uint32) ([]uint32, []uint32, bool, error)
}

type Segment struct {
	Growing           *core.GrowingSegment
	Frozen            *core.FrozenSegment
	State             *core.FrozenSegmentState
	Paged             PagedPostings
	Positions         FrozenPositions
	SpellingRuns      *core.FrozenSpellingRuns
	FrozenLengths     [][]uint32
	FrozenFieldTotals []float64
	Live              []uint32
	Fields            FieldIndexes
}

type View struct {
	FieldNames []string
	Schema     map[string]schema.ParsedFieldType
	Segments   []Segment
}

func (s *Segment) valid() bool {
	if s.Growing != nil {
		return s.Frozen == nil && s.State == nil
	}
	return s.Frozen != nil && s.State != nil
}

func (s *Segment) headersHeld() bool {
	if s.Growing != nil {
		return len(s.Growing.Terms.Header) > core.TermHeaderCount && len(s.Growing.TotalDocuments) > 0
	}
	return len(s.State.TombstoneCount) > 0 && len(s.State.PendingHeader) > core.PendingDocuments
}

func (s *Segment) fieldPrefix() int {
	if s.Growing != nil {
		return min(len(s.Growing.PartialFields), len(s.Growing.TotalFieldLengths))
	}
	return len(s.Frozen.PartialFields)
}

func (s *Segment) holdsFields(fields int) bool {
	prefix := s.fieldPrefix()
	if prefix > fields {
		return false
	}
	if s.Growing != nil {
		return uint64(prefix)*uint64(s.Growing.OrdinalCapacity) <= uint64(len(s.Growing.FieldLengths))
	}
	if prefix > len(s.FrozenFieldTotals) || prefix > len(s.FrozenLengths) {
		return false
	}
	for field := range prefix {
		if len(s.FrozenLengths[field]) < int(s.Frozen.DocumentCount) {
			return false
		}
	}
	return true
}

func (s *Segment) capacity() uint32 {
	if s.Growing != nil {
		return s.Growing.OrdinalCapacity
	}
	return s.Frozen.DocumentCount
}

func (s *Segment) liveDocuments() float64 {
	if s.Growing != nil {
		return float64(s.Growing.TotalDocuments[0])
	}
	return float64(s.Frozen.DocumentCount) - float64(s.State.TombstoneCount[0])
}

func (s *Segment) fieldTotal(field int) (float64, bool) {
	if s.Growing != nil {
		if field >= len(s.Growing.TotalFieldLengths) {
			return 0, false
		}
		total := s.Growing.TotalFieldLengths[field]
		return total, total > 0
	}
	if field >= s.fieldPrefix() {
		return 0, false
	}
	return s.FrozenFieldTotals[field], true
}

func (s *Segment) lengthColumn(field int, zeros []uint32) []uint32 {
	if field >= s.fieldPrefix() {
		return zeros[:s.capacity()]
	}
	if s.Growing != nil {
		capacity := int(s.Growing.OrdinalCapacity)
		start := field * capacity
		return s.Growing.FieldLengths[start : start+capacity]
	}
	return s.FrozenLengths[field][:s.Frozen.DocumentCount]
}

func (s *Segment) removed() []uint32 {
	if s.Growing != nil {
		return s.Growing.Retired
	}
	return s.State.Tombstones
}

func (s *Segment) dictionary() *core.TermDictionary {
	if s.Growing != nil {
		return s.Growing.Dictionary()
	}
	return s.Frozen.Dictionary(s.State)
}

func (s *Segment) expansionSource() core.ExpansionSegment {
	if s.Growing != nil {
		return core.ExpansionSegment{Growing: s.Growing}
	}
	if s.Paged != nil {
		totals, _ := s.Paged.TermTotals()
		return core.ExpansionSegment{Frozen: s.Frozen, State: s.State, Occurrences: totals}
	}
	return core.ExpansionSegment{Frozen: s.Frozen, State: s.State}
}

func (s *Segment) pagedTotalsHeld() (bool, error) {
	if s.Paged == nil {
		return true, nil
	}
	totals, err := s.Paged.TermTotals()
	if err != nil {
		return false, err
	}
	return s.Growing == nil && len(totals) == len(s.Frozen.Terms.Counts), nil
}

func bitsetWords(capacity uint32) int {
	return max(1, (int(capacity)+31)>>5)
}
