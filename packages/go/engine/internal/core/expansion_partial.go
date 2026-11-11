package core

/*
#include "native/include/narsil_expansion.h"
*/
import "C"

import "runtime"

type FrozenSpellingRuns struct {
	Points  []uint32
	Offsets []uint32
	Members []uint32
}

func (r *FrozenSpellingRuns) valid() bool {
	if len(r.Offsets) == 0 {
		return len(r.Points) == 0 && len(r.Members) == 0
	}
	return len(r.Points)%RunCodePoints == 0 && len(r.Offsets) == len(r.Points)/RunCodePoints+1
}

type PartialWordSource struct {
	Segment ExpansionSegment
	Runs    *FrozenSpellingRuns
}

type PartialWord struct {
	Written      []uint16
	Own          []uint16
	Tolerance    uint32
	PrefixLength uint32
}

type PartialWordsRequest struct {
	Sources []PartialWordSource
	Words   []PartialWord
}

type PartialWordsOutput struct {
	Additions ExpansionOutput
	Starts    []uint32
}

func partialSources(held *pins, sources []PartialWordSource) ([]C.narsil_expansion_segment, []C.narsil_frozen_runs, bool) {
	segments := make([]C.narsil_expansion_segment, len(sources))
	runs := make([]C.narsil_frozen_runs, len(sources))
	for index := range sources {
		source := &sources[index]
		segment, ok := source.Segment.native(held)
		if !ok {
			return nil, nil, false
		}
		segments[index] = segment
		if source.Runs == nil {
			continue
		}
		if source.Segment.Growing != nil || !source.Runs.valid() {
			return nil, nil, false
		}
		runs[index] = C.narsil_frozen_runs{
			points:       (*C.uint32_t)(pinned(held, source.Runs.Points)),
			point_count:  C.size_t(len(source.Runs.Points)),
			offsets:      (*C.uint32_t)(pinned(held, source.Runs.Offsets)),
			offset_count: C.size_t(len(source.Runs.Offsets)),
			members:      (*C.uint32_t)(pinned(held, source.Runs.Members)),
			member_count: C.size_t(len(source.Runs.Members)),
		}
	}
	return segments, runs, true
}

func partialWords(held *pins, words []PartialWord) ([]C.narsil_partial_word, bool) {
	natives := make([]C.narsil_partial_word, len(words))
	for index := range words {
		word := &words[index]
		if !queryTextsFit(word.Written, word.Own) {
			return nil, false
		}
		natives[index] = C.narsil_partial_word{
			written:        (*C.uint16_t)(pinned(held, word.Written)),
			written_length: C.size_t(len(word.Written)),
			own:            (*C.uint16_t)(pinned(held, word.Own)),
			own_length:     C.size_t(len(word.Own)),
			tolerance:      C.uint32_t(word.Tolerance),
			prefix_length:  C.uint32_t(word.PrefixLength),
		}
	}
	return natives, true
}

func (w *Workspace) ExpandPartialWords(request *PartialWordsRequest, output *PartialWordsOutput) (uint32, error) {
	var held pins
	defer held.release()
	segments, runs, sourcesValid := partialSources(&held, request.Sources)
	words, wordsValid := partialWords(&held, request.Words)
	if !sourcesValid || !wordsValid {
		return 0, &StatusError{Operation: "expandPartialWords", Status: StatusInvalidArgument}
	}
	native := C.narsil_partial_request{
		segments:      pinned(&held, segments),
		runs:          pinned(&held, runs),
		segment_count: C.size_t(len(segments)),
		words:         pinned(&held, words),
		word_count:    C.size_t(len(words)),
	}
	out := C.narsil_partial_output{
		additions:      output.Additions.native(&held),
		starts:         (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity: C.size_t(len(output.Starts)),
	}
	var count C.uint32_t
	status := C.narsil_expand_partial_words(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("expandPartialWords", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
