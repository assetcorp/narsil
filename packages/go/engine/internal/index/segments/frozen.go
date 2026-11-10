package segments

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

var (
	ErrSegmentFull   = errors.New("a surface or spelling count of the merged segment would pass 0xFFFFFFFF")
	ErrInvalidInput  = errors.New("the segment input breaks a rule of the native core layout")
	ErrTombstoned    = errors.New("the frozen segment already removed this ordinal")
	ErrUnsplittable  = errors.New("the merge holds fewer than two documents, so it cannot split")
	ErrPendingRemove = errors.New("the frozen segment state holds removals that are not settled")
	ErrStalePrepare  = errors.New("the state changed after this removal was prepared, so it cannot publish")
	ErrEmptyMerge    = errors.New("the merge keeps no documents, so it would build an empty segment")
	ErrMissingTokens = errors.New("the selection drops a live document whose tokens the caller did not supply")
)

type Field[T any] struct {
	Path  string
	Index T
}

type FieldSet[S any] struct {
	Numeric []Field[*core.NumericIndex]
	Sizes   []Field[*core.NumericIndex]
	Boolean []Field[*core.BooleanIndex]
	Enum    []Field[*core.EnumIndex]
	Geo     []Field[*core.GeoIndex]
	Pattern []Field[*core.PatternIndex]
	Stored  []Field[S]
}

type GrowingFields = FieldSet[*core.StoredValues]

type FrozenFields = FieldSet[*core.StoredValueRegions]

type Keyword struct {
	Segment           core.FrozenSegment
	FieldNames        []string
	PartialFieldNames []string
	FieldLengths      [][]uint32
	TotalFieldLengths []float64
	PositionOffsets   []uint32
	PositionValues    []uint32
	SpellingRuns      core.FrozenSpellingRuns
}

type Frozen struct {
	Keyword Keyword
	Fields  FrozenFields
}

func (f *Frozen) DocumentCount() uint32 {
	return f.Keyword.Segment.DocumentCount
}

func (f *Frozen) Core() *core.FrozenSegment {
	return &f.Keyword.Segment
}

func (f *Frozen) StoredValues(path string) *core.StoredValues {
	for _, entry := range f.Fields.Stored {
		if entry.Path == path {
			return entry.Index.Values()
		}
	}
	return nil
}

func termOrdinal(terms *core.FrozenStrings, text []byte) (uint32, bool) {
	low, high := 0, len(terms.Counts)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if compareBytes(terms.Text[terms.Offsets[middle]:terms.Offsets[middle+1]], text) < 0 {
			low = middle + 1
		} else {
			high = middle
		}
	}
	if low < len(terms.Counts) && compareBytes(terms.Text[terms.Offsets[low]:terms.Offsets[low+1]], text) == 0 {
		return uint32(low), true
	}
	return 0, false
}

func compareBytes(left, right []byte) int {
	shorter := min(len(left), len(right))
	for at := range shorter {
		if left[at] != right[at] {
			return int(left[at]) - int(right[at])
		}
	}
	return len(left) - len(right)
}

func identitySlots(count int) []uint32 {
	slots := make([]uint32, count)
	for at := range slots {
		slots[at] = uint32(at)
	}
	return slots
}

func buildRemovalIndex(segment *core.FrozenSegment) *core.FrozenRemovalIndex {
	documents := segment.DocumentCount
	starts := make([]uint32, uint64(documents)+1)
	for _, document := range segment.PostingDocuments {
		if document < documents {
			starts[document+1]++
		}
	}
	for ordinal := range documents {
		starts[ordinal+1] += starts[ordinal]
	}
	cursors := make([]uint32, documents)
	copy(cursors, starts[:documents])
	rows := make([]uint32, len(segment.PostingDocuments))
	for row, document := range segment.PostingDocuments {
		if document < documents {
			rows[cursors[document]] = uint32(row)
			cursors[document]++
		}
	}
	termOfSlot := make([]uint32, len(segment.PayloadSlots))
	for term, slot := range segment.PayloadSlots {
		if int(slot) < len(termOfSlot) {
			termOfSlot[slot] = uint32(term)
		}
	}
	return &core.FrozenRemovalIndex{Starts: starts, Rows: rows, TermOfSlot: termOfSlot}
}
