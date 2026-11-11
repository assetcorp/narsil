package core

/*
#include "native/include/narsil_segment_merge.h"
*/
import "C"

import "math"

type KeywordMergeInput struct {
	Growing            *GrowingSegment
	Terms              FrozenStrings
	PayloadSlots       []uint32
	PostingOffsets     []uint32
	PostingDocuments   []uint32
	PostingFrequencies []uint16
	PostingFields      []uint16
	PositionOffsets    []uint32
	PositionValues     []uint32
	Mapping            []uint32
	FieldMapping       []uint16
	FieldLengths       [][]uint32
	DocumentCount      uint32
	Surfaces           *FrozenStrings
	Spellings          *FrozenStrings
}

type KeywordMergeRequest struct {
	Inputs        []KeywordMergeInput
	DocumentCount uint32
	FieldCount    uint32
	RetainedTerms *FrozenStrings
}

type mergeInputStrings struct {
	surfaces  C.narsil_frozen_strings
	spellings C.narsil_frozen_strings
}

func (m *KeywordMergeInput) validPostings() bool {
	postings := uint64(len(m.PostingDocuments))
	terms := uint64(len(m.Terms.Counts))
	if m.Growing == nil && (uint64(len(m.PayloadSlots)) != terms || uint64(len(m.PostingOffsets)) != terms+1) {
		return false
	}
	if postings > math.MaxUint32 || uint64(len(m.PostingFrequencies)) != postings ||
		uint64(len(m.PostingFields)) != postings || (m.PositionOffsets == nil) != (m.PositionValues == nil) ||
		(m.PositionOffsets != nil && uint64(len(m.PositionOffsets)) != postings+1) {
		return false
	}
	fields := len(m.FieldLengths)
	if fields > MaxSegmentFields || len(m.FieldMapping) != fields ||
		uint64(len(m.Mapping)) != uint64(m.DocumentCount) {
		return false
	}
	for _, lengths := range m.FieldLengths {
		if lengths != nil && uint64(len(lengths)) != uint64(m.DocumentCount) {
			return false
		}
	}
	return true
}

func (m *KeywordMergeInput) native(held *pins, native *C.narsil_keyword_merge_input) bool {
	if !m.validPostings() {
		return false
	}
	if m.Growing != nil {
		growing, ok := m.Growing.native(held)
		if !ok {
			return false
		}
		native.growing = &growing.segment
	} else {
		terms, ok := m.Terms.native(held, termStringStride)
		if !ok {
			return false
		}
		native.terms = terms
	}
	if !m.nativeStrings(held, native) {
		return false
	}
	native.payload_slots = (*C.uint32_t)(pinned(held, m.PayloadSlots))
	native.posting_offsets = (*C.uint32_t)(pinned(held, m.PostingOffsets))
	native.posting_documents = (*C.uint32_t)(pinned(held, m.PostingDocuments))
	native.posting_frequencies = (*C.uint16_t)(pinned(held, m.PostingFrequencies))
	native.posting_fields = (*C.uint16_t)(pinned(held, m.PostingFields))
	native.posting_count = C.size_t(len(m.PostingDocuments))
	native.position_offsets = (*C.uint32_t)(pinned(held, m.PositionOffsets))
	native.position_values = (*C.uint32_t)(pinned(held, m.PositionValues))
	native.position_count = C.size_t(len(m.PositionValues))
	native.mapping = (*C.uint32_t)(pinned(held, m.Mapping))
	native.field_mapping = (*C.uint16_t)(pinned(held, m.FieldMapping))
	native.field_count = C.uint32_t(len(m.FieldLengths))
	native.document_count = C.uint32_t(m.DocumentCount)
	if len(m.FieldLengths) > 0 {
		columns := make([]*C.uint32_t, len(m.FieldLengths))
		for field, lengths := range m.FieldLengths {
			columns[field] = (*C.uint32_t)(pinned(held, lengths))
		}
		native.field_lengths = pinned(held, columns)
	}
	return true
}

func (m *KeywordMergeInput) nativeStrings(held *pins, native *C.narsil_keyword_merge_input) bool {
	if m.Surfaces == nil && m.Spellings == nil {
		return true
	}
	holder := new(mergeInputStrings)
	held.pinner.Pin(holder)
	ok := true
	if m.Surfaces != nil {
		if holder.surfaces, ok = m.Surfaces.native(held, mergedPairStride); ok {
			native.surfaces = &holder.surfaces
		}
	}
	if ok && m.Spellings != nil {
		if holder.spellings, ok = m.Spellings.native(held, mergedPairStride); ok {
			native.spellings = &holder.spellings
		}
	}
	return ok
}

func (r *KeywordMergeRequest) native(held *pins) (*C.narsil_keyword_merge_request, bool) {
	if r == nil || r.FieldCount > MaxSegmentFields {
		return nil, false
	}
	holder := make([]C.narsil_keyword_merge_request, 1)
	request := pinned(held, holder)
	request.document_count = C.uint32_t(r.DocumentCount)
	request.field_count = C.uint32_t(r.FieldCount)
	if len(r.Inputs) > 0 {
		inputs := make([]C.narsil_keyword_merge_input, len(r.Inputs))
		request.inputs = pinned(held, inputs)
		request.input_count = C.size_t(len(inputs))
		for at := range r.Inputs {
			if !r.Inputs[at].native(held, &inputs[at]) {
				return nil, false
			}
		}
	}
	if r.RetainedTerms != nil {
		retained := make([]C.narsil_frozen_strings, 1)
		terms, ok := r.RetainedTerms.native(held, termStringStride)
		if !ok {
			return nil, false
		}
		retained[0] = terms
		request.retained_terms = pinned(held, retained)
	}
	return request, true
}
