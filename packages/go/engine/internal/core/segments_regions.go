package core

/*
#include "native/include/narsil_segments.h"
*/
import "C"

import "math"

const (
	SliceAllocationWords = 2
	RunTableHeaderWords  = 8
	RunCodePoints        = 3
	NoFreeSlice          = math.MaxUint32
)

type SliceAllocator struct {
	Allocation      []uint32
	FreeHeads       []uint32
	SliceCapacities []uint32
}

func (a *SliceAllocator) native(held *pins) (C.narsil_slice_allocator, bool) {
	if len(a.Allocation) != SliceAllocationWords || len(a.FreeHeads) != len(a.SliceCapacities) {
		return C.narsil_slice_allocator{}, false
	}
	return C.narsil_slice_allocator{
		allocation:       (*C.uint32_t)(pinned(held, a.Allocation)),
		free_heads:       (*C.uint32_t)(pinned(held, a.FreeHeads)),
		slice_capacities: (*C.uint32_t)(pinned(held, a.SliceCapacities)),
		class_count:      C.size_t(len(a.SliceCapacities)),
	}, true
}

type TermColumns struct {
	SliceStart         []uint32
	SliceClass         []uint8
	Lengths            []uint32
	DocFrequency       []uint32
	DeadDocuments      []uint32
	TotalTermFrequency []float64
	SurfaceOccurrences []float64
	Revision           []uint32
	Flags              []uint8
}

func (c *TermColumns) native(held *pins) (C.narsil_term_columns, bool) {
	capacity := len(c.SliceStart)
	if len(c.SliceClass) != capacity || len(c.Lengths) != capacity || len(c.DocFrequency) != capacity ||
		len(c.DeadDocuments) != capacity || len(c.TotalTermFrequency) != capacity ||
		len(c.SurfaceOccurrences) != capacity || len(c.Revision) != capacity || len(c.Flags) != capacity {
		return C.narsil_term_columns{}, false
	}
	return C.narsil_term_columns{
		slice_start:          (*C.uint32_t)(pinned(held, c.SliceStart)),
		slice_class:          (*C.uint8_t)(pinned(held, c.SliceClass)),
		lengths:              (*C.uint32_t)(pinned(held, c.Lengths)),
		doc_frequency:        (*C.uint32_t)(pinned(held, c.DocFrequency)),
		dead_documents:       (*C.uint32_t)(pinned(held, c.DeadDocuments)),
		total_term_frequency: (*C.double)(pinned(held, c.TotalTermFrequency)),
		surface_occurrences:  (*C.double)(pinned(held, c.SurfaceOccurrences)),
		revision:             (*C.uint32_t)(pinned(held, c.Revision)),
		flags:                (*C.uint8_t)(pinned(held, c.Flags)),
		capacity:             C.size_t(capacity),
	}, true
}

type PostingPool struct {
	DocIDs         []uint32
	Frequencies    []uint16
	FieldIndices   []uint16
	PositionStarts []uint32
	Allocator      SliceAllocator
}

func (p *PostingPool) native(held *pins) (C.narsil_posting_pool, bool) {
	capacity := len(p.DocIDs)
	allocator, ok := p.Allocator.native(held)
	if !ok || len(p.Frequencies) != capacity || len(p.FieldIndices) != capacity ||
		(p.PositionStarts != nil && len(p.PositionStarts) != capacity) {
		return C.narsil_posting_pool{}, false
	}
	pool := C.narsil_posting_pool{
		doc_ids:       (*C.uint32_t)(pinned(held, p.DocIDs)),
		frequencies:   (*C.uint16_t)(pinned(held, p.Frequencies)),
		field_indices: (*C.uint16_t)(pinned(held, p.FieldIndices)),
		capacity:      C.size_t(capacity),
		allocator:     allocator,
	}
	if p.PositionStarts != nil {
		starts := p.PositionStarts
		if len(starts) == 0 {
			starts = make([]uint32, 1)
		}
		pool.position_starts = (*C.uint32_t)(pinned(held, starts))
	}
	return pool, true
}

type PositionPool struct {
	Values     []uint32
	Allocation []uint32
}

func (p *PositionPool) native(held *pins) (C.narsil_position_pool, bool) {
	if len(p.Allocation) != SliceAllocationWords {
		return C.narsil_position_pool{}, false
	}
	return C.narsil_position_pool{
		values:     (*C.uint32_t)(pinned(held, p.Values)),
		capacity:   C.size_t(len(p.Values)),
		allocation: (*C.uint32_t)(pinned(held, p.Allocation)),
	}, true
}

type SurfaceTable struct {
	Strings TermTable
	Token   []uint32
	Count   []uint32
}

func (s *SurfaceTable) native(held *pins) (C.narsil_surface_table, bool) {
	capacity := len(s.Token)
	if len(s.Count) != capacity || len(s.Strings.TermOffset) != capacity {
		return C.narsil_surface_table{}, false
	}
	return C.narsil_surface_table{
		strings:  s.Strings.native(held),
		token:    (*C.uint32_t)(pinned(held, s.Token)),
		count:    (*C.uint32_t)(pinned(held, s.Count)),
		capacity: C.size_t(capacity),
	}, true
}

type RunTable struct {
	Header     []uint32
	Slots      []int32
	Runs       []uint32
	ListStart  []uint32
	ListLength []uint32
	ListClass  []uint8
	Members    []uint32
	Allocator  SliceAllocator
}

func (r *RunTable) native(held *pins) (C.narsil_run_table, bool) {
	capacity := len(r.ListStart)
	allocator, ok := r.Allocator.native(held)
	if !ok || len(r.Header) != RunTableHeaderWords || uint64(len(r.Runs)) != uint64(capacity)*RunCodePoints ||
		len(r.ListLength) != capacity || len(r.ListClass) != capacity {
		return C.narsil_run_table{}, false
	}
	return C.narsil_run_table{
		header:          (*C.uint32_t)(pinned(held, r.Header)),
		slots:           (*C.int32_t)(pinned(held, r.Slots)),
		slot_capacity:   C.size_t(len(r.Slots)),
		runs:            (*C.uint32_t)(pinned(held, r.Runs)),
		list_start:      (*C.uint32_t)(pinned(held, r.ListStart)),
		list_length:     (*C.uint32_t)(pinned(held, r.ListLength)),
		list_class:      (*C.uint8_t)(pinned(held, r.ListClass)),
		capacity:        C.size_t(capacity),
		members:         (*C.uint32_t)(pinned(held, r.Members)),
		member_capacity: C.size_t(len(r.Members)),
		allocator:       allocator,
	}, true
}

type SpellingTable struct {
	Entries    SurfaceTable
	CodePoints []uint32
	Runs       RunTable
}

func (s *SpellingTable) native(held *pins) (C.narsil_spelling_table, bool) {
	entries, ok := s.Entries.native(held)
	if !ok || len(s.CodePoints) != len(s.Entries.Token) {
		return C.narsil_spelling_table{}, false
	}
	runs, ok := s.Runs.native(held)
	if !ok {
		return C.narsil_spelling_table{}, false
	}
	return C.narsil_spelling_table{
		entries:     entries,
		code_points: (*C.uint32_t)(pinned(held, s.CodePoints)),
		runs:        runs,
	}, true
}

type GrowingSegment struct {
	Terms             TermTable
	Columns           TermColumns
	Postings          PostingPool
	Positions         *PositionPool
	Surfaces          *SurfaceTable
	Spellings         *SpellingTable
	Retired           []uint32
	FieldLengths      []uint32
	TotalDocuments    []uint32
	TotalFieldLengths []float64
	PartialFields     []uint8
	OrdinalCapacity   uint32
}

type growingSegmentNative struct {
	segment   C.narsil_growing_segment
	positions C.narsil_position_pool
	surfaces  C.narsil_surface_table
	spellings C.narsil_spelling_table
}

func (s *GrowingSegment) validValues() bool {
	fields := uint64(len(s.PartialFields))
	capacity := uint64(s.OrdinalCapacity)
	return fields <= MaxSegmentFields && uint64(len(s.FieldLengths)) == fields*capacity &&
		uint64(len(s.Retired)) == bitsetWords(capacity) && len(s.TotalDocuments) == 1 &&
		uint64(len(s.TotalFieldLengths)) == fields
}

func (s *GrowingSegment) native(held *pins) (*growingSegmentNative, bool) {
	if s == nil || !s.validValues() {
		return nil, false
	}
	holder := new(growingSegmentNative)
	held.pinner.Pin(holder)
	columns, ok := s.Columns.native(held)
	if !ok {
		return nil, false
	}
	postings, ok := s.Postings.native(held)
	if !ok {
		return nil, false
	}
	holder.segment = C.narsil_growing_segment{
		terms:               s.Terms.native(held),
		columns:             columns,
		postings:            postings,
		retired:             (*C.uint32_t)(pinned(held, s.Retired)),
		field_lengths:       (*C.uint32_t)(pinned(held, s.FieldLengths)),
		total_documents:     (*C.uint32_t)(pinned(held, s.TotalDocuments)),
		total_field_lengths: (*C.double)(pinned(held, s.TotalFieldLengths)),
		partial_fields:      (*C.uint8_t)(pinned(held, s.PartialFields)),
		ordinal_capacity:    C.uint32_t(s.OrdinalCapacity),
		field_count:         C.uint32_t(len(s.PartialFields)),
	}
	if !s.nativeOptional(held, holder) {
		return nil, false
	}
	return holder, true
}

func (s *GrowingSegment) nativeOptional(held *pins, holder *growingSegmentNative) bool {
	ok := true
	if s.Positions != nil {
		holder.positions, ok = s.Positions.native(held)
		holder.segment.positions = &holder.positions
	}
	if ok && s.Surfaces != nil {
		holder.surfaces, ok = s.Surfaces.native(held)
		holder.segment.surfaces = &holder.surfaces
	}
	if ok && s.Spellings != nil {
		holder.spellings, ok = s.Spellings.native(held)
		holder.segment.spellings = &holder.spellings
	}
	return ok
}
