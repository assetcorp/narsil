package core

/*
#include "native/include/narsil_suggestions.h"
*/
import "C"

import "runtime"

const (
	SuggestionToken   = C.NARSIL_SUGGESTION_TOKEN
	SuggestionSurface = C.NARSIL_SUGGESTION_SURFACE
	SuggestionWords   = C.NARSIL_SUGGESTION_WORDS
)

type SuggestionRequest struct {
	Segments []ExpansionSegment
	Typed    []uint16
	Stemmed  []uint16
	Limit    uint32
}

type SuggestionOutput struct {
	Terms       []uint32
	Starts      []uint32
	Spellings   []uint32
	Occurrences []float64
}

func (w *Workspace) SuggestTerms(request *SuggestionRequest, output *SuggestionOutput) (uint32, error) {
	if !queryTextsFit(request.Typed, request.Stemmed) {
		return 0, &StatusError{Operation: "suggestTerms", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	segments, ok := expansionSegments(&held, request.Segments)
	if !ok {
		return 0, &StatusError{Operation: "suggestTerms", Status: StatusInvalidArgument}
	}
	native := C.narsil_suggestion_request{
		segments:       pinned(&held, segments),
		segment_count:  C.size_t(len(segments)),
		typed:          (*C.uint16_t)(pinned(&held, request.Typed)),
		typed_length:   C.size_t(len(request.Typed)),
		stemmed:        (*C.uint16_t)(pinned(&held, request.Stemmed)),
		stemmed_length: C.size_t(len(request.Stemmed)),
		limit:          C.uint32_t(request.Limit),
	}
	out := C.narsil_suggestion_output{
		terms:               (*C.uint32_t)(pinned(&held, output.Terms)),
		term_words:          C.size_t(len(output.Terms)),
		starts:              (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity:      C.size_t(len(output.Starts)),
		spellings:           (*C.uint32_t)(pinned(&held, output.Spellings)),
		spelling_words:      C.size_t(len(output.Spellings)),
		occurrences:         (*C.double)(pinned(&held, output.Occurrences)),
		occurrence_capacity: C.size_t(len(output.Occurrences)),
	}
	var count C.uint32_t
	status := C.narsil_suggest_terms(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("suggestTerms", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
