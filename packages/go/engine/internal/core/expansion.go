package core

/*
#include "native/include/narsil_expansion.h"
*/
import "C"

import "runtime"

type ExpansionSegment struct {
	Growing     *GrowingSegment
	Frozen      *FrozenSegment
	State       *FrozenSegmentState
	Occurrences []float64
}

func (s *ExpansionSegment) native(held *pins) (C.narsil_expansion_segment, bool) {
	if s.Growing != nil {
		if s.Frozen != nil || s.State != nil || s.Occurrences != nil {
			return C.narsil_expansion_segment{}, false
		}
		holder, ok := s.Growing.native(held)
		if !ok {
			return C.narsil_expansion_segment{}, false
		}
		return C.narsil_expansion_segment{growing: &holder.segment}, true
	}
	if s.Frozen == nil || s.State == nil || (s.Occurrences != nil && len(s.Occurrences) != len(s.Frozen.Terms.Counts)) {
		return C.narsil_expansion_segment{}, false
	}
	holder, ok := nativeFrozen(held, s.Frozen, s.State)
	if !ok {
		return C.narsil_expansion_segment{}, false
	}
	return C.narsil_expansion_segment{
		frozen:           &holder.segment,
		state:            &holder.state,
		occurrences:      (*C.double)(pinned(held, s.Occurrences)),
		occurrence_count: C.size_t(len(s.Occurrences)),
	}, true
}

func expansionSegments(held *pins, segments []ExpansionSegment) ([]C.narsil_expansion_segment, bool) {
	natives := make([]C.narsil_expansion_segment, len(segments))
	for index := range segments {
		native, ok := segments[index].native(held)
		if !ok {
			return nil, false
		}
		natives[index] = native
	}
	return natives, true
}

func queryTextsFit(texts ...[]uint16) bool {
	for _, text := range texts {
		if len(text) > MaxAnalysedUnits {
			return false
		}
	}
	return true
}

type PrefixExpansionRequest struct {
	Segments []ExpansionSegment
	Typed    []uint16
	Stemmed  []uint16
	Own      []uint16
}

type ExpansionOutput struct {
	Segments []uint32
	Tokens   []uint32
	Factors  []float64
}

func (o *ExpansionOutput) native(held *pins) C.narsil_expansion_output {
	return C.narsil_expansion_output{
		segments:         (*C.uint32_t)(pinned(held, o.Segments)),
		segment_capacity: C.size_t(len(o.Segments)),
		tokens:           (*C.uint32_t)(pinned(held, o.Tokens)),
		token_capacity:   C.size_t(len(o.Tokens)),
		factors:          (*C.double)(pinned(held, o.Factors)),
		factor_capacity:  C.size_t(len(o.Factors)),
	}
}

func (w *Workspace) ExpandPrefix(request *PrefixExpansionRequest, output *ExpansionOutput) (uint32, error) {
	if !queryTextsFit(request.Typed, request.Stemmed, request.Own) {
		return 0, &StatusError{Operation: "expandPrefix", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	segments, ok := expansionSegments(&held, request.Segments)
	if !ok {
		return 0, &StatusError{Operation: "expandPrefix", Status: StatusInvalidArgument}
	}
	native := C.narsil_prefix_request{
		segments:       pinned(&held, segments),
		segment_count:  C.size_t(len(segments)),
		typed:          (*C.uint16_t)(pinned(&held, request.Typed)),
		typed_length:   C.size_t(len(request.Typed)),
		stemmed:        (*C.uint16_t)(pinned(&held, request.Stemmed)),
		stemmed_length: C.size_t(len(request.Stemmed)),
		own:            (*C.uint16_t)(pinned(&held, request.Own)),
		own_length:     C.size_t(len(request.Own)),
	}
	out := output.native(&held)
	var count C.uint32_t
	status := C.narsil_expand_prefix(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("expandPrefix", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
