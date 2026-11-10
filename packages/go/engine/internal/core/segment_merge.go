package core

/*
#include "native/include/narsil_segment_merge.h"
*/
import "C"

import (
	"math"
	"runtime"
)

const MergeDroppedOrdinal = math.MaxUint32

type KeywordMergeSizes struct {
	Terms         uint32
	TermBytes     uint32
	Postings      uint32
	Positions     uint32
	HasPositions  bool
	Surfaces      uint32
	SurfaceBytes  uint32
	Spellings     uint32
	SpellingBytes uint32
}

type KeywordMergeOutput struct {
	Terms              FrozenStrings
	PostingOffsets     []uint32
	PostingDocuments   []uint32
	PostingFrequencies []uint16
	PostingFields      []uint16
	PositionOffsets    []uint32
	PositionValues     []uint32
	FieldLengths       []uint32
	TotalFieldLengths  []float64
	Surfaces           FrozenStrings
	Spellings          FrozenStrings
}

func NewKeywordMergeOutput(sizes KeywordMergeSizes, documentCount, fieldCount uint32) *KeywordMergeOutput {
	output := &KeywordMergeOutput{
		Terms:              newMergedStrings(sizes.Terms, sizes.TermBytes, termStringStride),
		PostingOffsets:     make([]uint32, uint64(sizes.Terms)+1),
		PostingDocuments:   make([]uint32, sizes.Postings),
		PostingFrequencies: make([]uint16, sizes.Postings),
		PostingFields:      make([]uint16, sizes.Postings),
		FieldLengths:       make([]uint32, uint64(documentCount)*uint64(fieldCount)),
		TotalFieldLengths:  make([]float64, fieldCount),
		Surfaces:           newMergedStrings(sizes.Surfaces, sizes.SurfaceBytes, mergedPairStride),
		Spellings:          newMergedStrings(sizes.Spellings, sizes.SpellingBytes, mergedPairStride),
	}
	if sizes.HasPositions {
		output.PositionOffsets = make([]uint32, uint64(sizes.Postings)+1)
		output.PositionValues = make([]uint32, sizes.Positions)
	}
	return output
}

func newMergedStrings(count, bytes uint32, stride uint64) FrozenStrings {
	return FrozenStrings{
		Text:    make([]byte, bytes),
		Offsets: make([]uint32, uint64(count)*stride+1),
		Counts:  make([]uint32, count),
	}
}

func (s *FrozenStrings) mergedNative(held *pins) C.narsil_merged_strings {
	return C.narsil_merged_strings{
		text:            (*C.uint8_t)(pinned(held, s.Text)),
		offsets:         (*C.uint32_t)(pinned(held, s.Offsets)),
		counts:          (*C.uint32_t)(pinned(held, s.Counts)),
		count_capacity:  C.size_t(len(s.Counts)),
		text_capacity:   C.size_t(len(s.Text)),
		offset_capacity: C.size_t(len(s.Offsets)),
	}
}

func (o *KeywordMergeOutput) native(held *pins) (*C.narsil_keyword_merge_output, bool) {
	postings := len(o.PostingDocuments)
	if len(o.PostingFrequencies) != postings || len(o.PostingFields) != postings ||
		(o.PositionOffsets == nil) != (o.PositionValues == nil) {
		return nil, false
	}
	holder := make([]C.narsil_keyword_merge_output, 1)
	output := pinned(held, holder)
	*output = C.narsil_keyword_merge_output{
		terms:                    o.Terms.mergedNative(held),
		posting_offsets:          (*C.uint32_t)(pinned(held, o.PostingOffsets)),
		posting_offset_capacity:  C.size_t(len(o.PostingOffsets)),
		posting_documents:        (*C.uint32_t)(pinned(held, o.PostingDocuments)),
		posting_frequencies:      (*C.uint16_t)(pinned(held, o.PostingFrequencies)),
		posting_fields:           (*C.uint16_t)(pinned(held, o.PostingFields)),
		posting_capacity:         C.size_t(postings),
		position_offsets:         (*C.uint32_t)(pinned(held, o.PositionOffsets)),
		position_offset_capacity: C.size_t(len(o.PositionOffsets)),
		position_values:          (*C.uint32_t)(pinned(held, o.PositionValues)),
		position_capacity:        C.size_t(len(o.PositionValues)),
		field_lengths:            (*C.uint32_t)(pinned(held, o.FieldLengths)),
		field_length_capacity:    C.size_t(len(o.FieldLengths)),
		total_field_lengths:      (*C.double)(pinned(held, o.TotalFieldLengths)),
		field_count:              C.size_t(len(o.TotalFieldLengths)),
		surfaces:                 o.Surfaces.mergedNative(held),
		spellings:                o.Spellings.mergedNative(held),
	}
	return output, true
}

func (w *Workspace) MeasureMerge(request *KeywordMergeRequest) (KeywordMergeSizes, error) {
	var held pins
	defer held.release()
	native, ok := request.native(&held)
	if !ok {
		return KeywordMergeSizes{}, segmentRefusal("measureMerge")
	}
	var sizes C.narsil_keyword_merge_sizes
	status := C.narsil_measure_merge(w.pointer(), native, &sizes)
	runtime.KeepAlive(w)
	if err := statusError("measureMerge", status); err != nil {
		return KeywordMergeSizes{}, err
	}
	return KeywordMergeSizes{
		Terms:         uint32(sizes.terms),
		TermBytes:     uint32(sizes.term_bytes),
		Postings:      uint32(sizes.postings),
		Positions:     uint32(sizes.positions),
		HasPositions:  sizes.has_positions != 0,
		Surfaces:      uint32(sizes.surfaces),
		SurfaceBytes:  uint32(sizes.surface_bytes),
		Spellings:     uint32(sizes.spellings),
		SpellingBytes: uint32(sizes.spelling_bytes),
	}, nil
}

func (w *Workspace) WriteMerge(request *KeywordMergeRequest, output *KeywordMergeOutput) error {
	if output == nil {
		return segmentRefusal("writeMerge")
	}
	var held pins
	defer held.release()
	native, ok := request.native(&held)
	if !ok {
		return segmentRefusal("writeMerge")
	}
	target, ok := output.native(&held)
	if !ok {
		return segmentRefusal("writeMerge")
	}
	status := C.narsil_write_merge(w.pointer(), native, target)
	runtime.KeepAlive(w)
	return statusError("writeMerge", status)
}
