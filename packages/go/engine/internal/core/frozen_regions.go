package core

/*
#include "native/include/narsil_frozen_segments.h"
*/
import "C"

import "math"

const (
	PendingHeaderWords = C.NARSIL_PENDING_HEADER_WORDS
	PendingDocuments   = C.NARSIL_PENDING_DOCUMENTS
	PendingTokens      = C.NARSIL_PENDING_TOKENS
	PendingUnits       = C.NARSIL_PENDING_UNITS
	PendingTokenWords  = C.NARSIL_PENDING_TOKEN_WORDS
)

const (
	termStringStride     = 1
	surfaceStringStride  = 2
	spellingStringStride = 1
	mergedPairStride     = 2
)

type FrozenStrings struct {
	Text    []byte
	Offsets []uint32
	Counts  []uint32
}

func (s *FrozenStrings) native(held *pins, stride uint64) (C.narsil_frozen_strings, bool) {
	count := uint64(len(s.Counts))
	if count > math.MaxUint32 || uint64(len(s.Text)) > math.MaxUint32 || uint64(len(s.Offsets)) != count*stride+1 {
		return C.narsil_frozen_strings{}, false
	}
	return C.narsil_frozen_strings{
		text:       (*C.uint8_t)(pinned(held, s.Text)),
		text_bytes: C.size_t(len(s.Text)),
		offsets:    (*C.uint32_t)(pinned(held, s.Offsets)),
		counts:     (*C.uint32_t)(pinned(held, s.Counts)),
		count:      C.size_t(count),
	}, true
}

type FrozenRemovalIndex struct {
	Starts     []uint32
	Rows       []uint32
	TermOfSlot []uint32
}

type FrozenSegment struct {
	Terms              FrozenStrings
	PayloadSlots       []uint32
	PostingOffsets     []uint32
	PostingDocuments   []uint32
	PostingFrequencies []uint16
	PostingFields      []uint16
	Surfaces           *FrozenStrings
	Spellings          *FrozenStrings
	SpellingTokens     []uint32
	RemovalIndex       *FrozenRemovalIndex
	PartialFields      []uint8
	DocumentCount      uint32
}

type FrozenSegmentState struct {
	Tombstones         []uint32
	TombstoneCount     []uint32
	RemovedDocuments   []uint32
	RemovedOccurrences []float64
	RemovedSurfaces    []uint32
	RemovedSpellings   []uint32
	PendingHeader      []uint32
	PendingDocuments   []uint32
	PendingTokens      []uint32
	PendingUnits       []uint16
}

type FrozenPagedRemovals struct {
	Cache   *PageCache
	Offsets PageSection
	Values  PageSection
}

type frozenSegmentNative struct {
	segment   C.narsil_frozen_segment
	state     C.narsil_frozen_segment_state
	surfaces  C.narsil_frozen_strings
	spellings C.narsil_frozen_strings
	index     C.narsil_frozen_removal_index
	paged     C.narsil_frozen_paged_removals
}

func (s *FrozenSegment) Dictionary(state *FrozenSegmentState) *TermDictionary {
	return &TermDictionary{
		Tokens:      s.Terms.Text,
		Offsets:     s.Terms.Offsets,
		Frequencies: s.Terms.Counts,
		Removed:     state.RemovedDocuments,
	}
}

func (s *FrozenSegment) stringCounts() (uint64, uint64) {
	var surfaces, spellings uint64
	if s.Surfaces != nil {
		surfaces = uint64(len(s.Surfaces.Counts))
	}
	if s.Spellings != nil {
		spellings = uint64(len(s.Spellings.Counts))
	}
	return surfaces, spellings
}

func (s *FrozenSegment) nativeStrings(held *pins, holder *frozenSegmentNative) bool {
	terms, ok := s.Terms.native(held, termStringStride)
	if !ok {
		return false
	}
	holder.segment.terms = terms
	if s.Surfaces != nil {
		if holder.surfaces, ok = s.Surfaces.native(held, surfaceStringStride); !ok {
			return false
		}
		holder.segment.surfaces = &holder.surfaces
	}
	if s.Spellings != nil {
		if holder.spellings, ok = s.Spellings.native(held, spellingStringStride); !ok {
			return false
		}
		holder.segment.spellings = &holder.spellings
	}
	return true
}

func (s *FrozenSegment) nativePostings(held *pins, holder *frozenSegmentNative) bool {
	terms := uint64(len(s.Terms.Counts))
	postings := uint64(len(s.PostingDocuments))
	_, spellings := s.stringCounts()
	if uint64(len(s.PayloadSlots)) != terms || uint64(len(s.PostingOffsets)) != terms+1 ||
		postings > math.MaxUint32 || uint64(len(s.PostingFrequencies)) != postings ||
		uint64(len(s.PostingFields)) != postings || len(s.PartialFields) > MaxSegmentFields ||
		uint64(len(s.SpellingTokens)) != spellings {
		return false
	}
	segment := &holder.segment
	segment.payload_slots = (*C.uint32_t)(pinned(held, s.PayloadSlots))
	segment.posting_offsets = (*C.uint32_t)(pinned(held, s.PostingOffsets))
	segment.posting_documents = (*C.uint32_t)(pinned(held, s.PostingDocuments))
	segment.posting_frequencies = (*C.uint16_t)(pinned(held, s.PostingFrequencies))
	segment.posting_fields = (*C.uint16_t)(pinned(held, s.PostingFields))
	segment.posting_count = C.size_t(postings)
	segment.partial_fields = (*C.uint8_t)(pinned(held, s.PartialFields))
	segment.field_count = C.uint32_t(len(s.PartialFields))
	segment.spelling_tokens = (*C.uint32_t)(pinned(held, s.SpellingTokens))
	segment.document_count = C.uint32_t(s.DocumentCount)
	return true
}

func (s *FrozenSegment) nativeIndex(held *pins, holder *frozenSegmentNative) bool {
	index := s.RemovalIndex
	if index == nil {
		return true
	}
	if uint64(len(index.Starts)) != uint64(s.DocumentCount)+1 || len(index.Rows) != len(s.PostingDocuments) ||
		len(index.TermOfSlot) != len(s.Terms.Counts) {
		return false
	}
	holder.index = C.narsil_frozen_removal_index{
		starts:       (*C.uint32_t)(pinned(held, index.Starts)),
		rows:         (*C.uint32_t)(pinned(held, index.Rows)),
		term_of_slot: (*C.uint32_t)(pinned(held, index.TermOfSlot)),
	}
	holder.segment.removal_index = &holder.index
	return true
}

func (s *FrozenSegment) nativeState(held *pins, state *FrozenSegmentState, holder *frozenSegmentNative) bool {
	surfaces, spellings := s.stringCounts()
	terms := uint64(len(s.Terms.Counts))
	if state == nil || uint64(len(state.Tombstones)) != bitsetWords(uint64(s.DocumentCount)) ||
		len(state.TombstoneCount) != 1 || uint64(len(state.RemovedDocuments)) != terms ||
		uint64(len(state.RemovedOccurrences)) != terms || uint64(len(state.RemovedSurfaces)) != surfaces ||
		uint64(len(state.RemovedSpellings)) != spellings || len(state.PendingHeader) != PendingHeaderWords ||
		len(state.PendingTokens)%PendingTokenWords != 0 {
		return false
	}
	holder.state = C.narsil_frozen_segment_state{
		tombstones:                (*C.uint32_t)(pinned(held, state.Tombstones)),
		tombstone_count:           (*C.uint32_t)(pinned(held, state.TombstoneCount)),
		removed_documents:         (*C.uint32_t)(pinned(held, state.RemovedDocuments)),
		removed_occurrences:       (*C.double)(pinned(held, state.RemovedOccurrences)),
		removed_surfaces:          (*C.uint32_t)(pinned(held, state.RemovedSurfaces)),
		removed_spellings:         (*C.uint32_t)(pinned(held, state.RemovedSpellings)),
		pending_header:            (*C.uint32_t)(pinned(held, state.PendingHeader)),
		pending_documents:         (*C.uint32_t)(pinned(held, state.PendingDocuments)),
		pending_document_capacity: C.size_t(len(state.PendingDocuments)),
		pending_tokens:            (*C.uint32_t)(pinned(held, state.PendingTokens)),
		pending_token_capacity:    C.size_t(len(state.PendingTokens) / PendingTokenWords),
		pending_units:             (*C.uint16_t)(pinned(held, state.PendingUnits)),
		pending_unit_capacity:     C.size_t(len(state.PendingUnits)),
	}
	return true
}

func (p *FrozenPagedRemovals) cache() *PageCache {
	if p == nil {
		return nil
	}
	return p.Cache
}

func (p *FrozenPagedRemovals) native(call *pagedCall, holder *frozenSegmentNative) (*C.narsil_frozen_paged_removals, error) {
	if p == nil {
		return nil, nil
	}
	sections, err := call.sections(&p.Offsets, &p.Values)
	if err != nil {
		return nil, err
	}
	call.held.pinner.Pin(call.results)
	holder.paged = C.narsil_frozen_paged_removals{
		cache:   call.cache,
		offsets: &sections[0],
		values:  &sections[1],
		fault:   &call.results.fault,
	}
	return &holder.paged, nil
}

func nativeFrozen(held *pins, segment *FrozenSegment, state *FrozenSegmentState) (*frozenSegmentNative, bool) {
	if segment == nil {
		return nil, false
	}
	holder := new(frozenSegmentNative)
	held.pinner.Pin(holder)
	if !segment.nativeStrings(held, holder) || !segment.nativePostings(held, holder) ||
		!segment.nativeState(held, state, holder) || !segment.nativeIndex(held, holder) {
		return nil, false
	}
	return holder, true
}
