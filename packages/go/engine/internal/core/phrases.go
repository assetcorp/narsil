package core

/*
#include "native/include/narsil_phrases.h"
*/
import "C"

import (
	"math"
	"runtime"
)

type PhrasePostings struct {
	Documents      []uint32
	Fields         []uint16
	PositionStarts []uint32
	PositionCounts []uint32
	Positions      []uint32
	Ordered        bool
}

type PhraseRequest struct {
	Postings     []PhrasePostings
	Starts       []uint32
	Tokens       []uint32
	Offsets      []uint32
	Searchable   []uint8
	HasFilter    bool
	Filter       []uint32
	Removed      []uint32
	OrdinalCount uint32
	Collect      bool
}

type PhraseOutput struct {
	Matched     []uint32
	Starts      []uint32
	Documents   []uint32
	Fields      []uint16
	Frequencies []uint32
}

func (p *PhrasePostings) native(held *pins) (C.narsil_phrase_postings, bool) {
	count := len(p.Documents)
	if len(p.Fields) != count || len(p.PositionStarts) != count || len(p.PositionCounts) != count {
		return C.narsil_phrase_postings{}, false
	}
	native := C.narsil_phrase_postings{
		documents:       (*C.uint32_t)(pinned(held, p.Documents)),
		fields:          (*C.uint16_t)(pinned(held, p.Fields)),
		position_starts: (*C.uint32_t)(pinned(held, p.PositionStarts)),
		position_counts: (*C.uint32_t)(pinned(held, p.PositionCounts)),
		count:           C.size_t(count),
		positions:       (*C.uint32_t)(pinned(held, p.Positions)),
		position_count:  C.size_t(len(p.Positions)),
	}
	if p.Ordered {
		native.ordered = 1
	}
	return native, true
}

func (r *PhraseRequest) valid() bool {
	return len(r.Starts) > 0 && len(r.Tokens) == len(r.Offsets) && len(r.Searchable) <= math.MaxUint32 &&
		(!r.HasFilter || len(r.Filter) > 0)
}

func (w *Workspace) MatchPhrases(request *PhraseRequest, meter *WorkMeter, output *PhraseOutput) (uint32, error) {
	if !request.valid() || meter == nil || meter.words == nil {
		return 0, &StatusError{Operation: "matchPhrases", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	postings := make([]C.narsil_phrase_postings, len(request.Postings))
	for index := range request.Postings {
		list, ok := request.Postings[index].native(&held)
		if !ok {
			return 0, &StatusError{Operation: "matchPhrases", Status: StatusInvalidArgument}
		}
		postings[index] = list
	}
	native := C.narsil_phrase_request{
		postings:      pinned(&held, postings),
		token_count:   C.size_t(len(postings)),
		starts:        (*C.uint32_t)(pinned(&held, request.Starts)),
		phrase_count:  C.size_t(len(request.Starts) - 1),
		tokens:        (*C.uint32_t)(pinned(&held, request.Tokens)),
		offsets:       (*C.uint32_t)(pinned(&held, request.Offsets)),
		entry_count:   C.size_t(len(request.Tokens)),
		searchable:    (*C.uint8_t)(pinned(&held, request.Searchable)),
		field_count:   C.uint32_t(len(request.Searchable)),
		removed:       (*C.uint32_t)(pinned(&held, request.Removed)),
		removed_words: C.size_t(len(request.Removed)),
		ordinal_count: C.uint32_t(request.OrdinalCount),
		meter:         meter.native(),
	}
	if request.HasFilter {
		native.filter = (*C.uint32_t)(pinned(&held, request.Filter))
		native.filter_words = C.size_t(len(request.Filter))
	}
	if request.Collect {
		native.collect = 1
	}
	out := C.narsil_phrase_output{
		matched:            (*C.uint32_t)(pinned(&held, output.Matched)),
		matched_words:      C.size_t(len(output.Matched)),
		starts:             (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity:     C.size_t(len(output.Starts)),
		documents:          (*C.uint32_t)(pinned(&held, output.Documents)),
		fields:             (*C.uint16_t)(pinned(&held, output.Fields)),
		frequencies:        (*C.uint32_t)(pinned(&held, output.Frequencies)),
		document_capacity:  C.size_t(len(output.Documents)),
		field_capacity:     C.size_t(len(output.Fields)),
		frequency_capacity: C.size_t(len(output.Frequencies)),
	}
	var rows C.uint32_t
	status := C.narsil_match_phrases(w.pointer(), &native, &out, &rows)
	runtime.KeepAlive(w)
	runtime.KeepAlive(meter)
	if err := statusError("matchPhrases", status); err != nil {
		return 0, err
	}
	return uint32(rows), nil
}
