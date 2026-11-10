package core

/*
#include "native/include/narsil_highlight.h"
*/
import "C"

import "runtime"

type HighlightTerm struct {
	Term      []uint16
	Tolerance uint32
}

type HighlightQuery struct {
	Terms        []HighlightTerm
	PrefixLength uint32
	Prefix       []uint16
	HasPrefix    bool
	Synonyms     [][]uint16
	PartialWords [][]uint16
}

type HighlightRequest struct {
	Language         uint32
	Text             []uint16
	Query            HighlightQuery
	PreTag           []uint16
	PostTag          []uint16
	MaxSnippetLength uint32
}

type HighlightOutput struct {
	Snippet   []uint16
	Positions []uint32
}

type HighlightOutcome struct {
	Count         uint32
	SnippetLength uint32
}

var emptyHighlightUnits = []uint16{0}

func highlightText(held *pins, units []uint16) C.narsil_highlight_text {
	if len(units) == 0 {
		return C.narsil_highlight_text{units: (*C.uint16_t)(pinned(held, emptyHighlightUnits))}
	}
	return C.narsil_highlight_text{units: (*C.uint16_t)(pinned(held, units)), length: C.size_t(len(units))}
}

func highlightTexts(held *pins, texts [][]uint16) []C.narsil_highlight_text {
	natives := make([]C.narsil_highlight_text, len(texts))
	for index, text := range texts {
		natives[index] = highlightText(held, text)
	}
	return natives
}

func (q *HighlightQuery) fits() bool {
	if !queryTextsFit(q.Prefix) || !queryTextsFit(q.Synonyms...) || !queryTextsFit(q.PartialWords...) {
		return false
	}
	for index := range q.Terms {
		if !queryTextsFit(q.Terms[index].Term) {
			return false
		}
	}
	return true
}

func (q *HighlightQuery) native(held *pins) C.narsil_highlight_query {
	terms := make([]C.narsil_highlight_term, len(q.Terms))
	for index := range q.Terms {
		terms[index] = C.narsil_highlight_term{
			text:      highlightText(held, q.Terms[index].Term),
			tolerance: C.uint32_t(q.Terms[index].Tolerance),
		}
	}
	synonyms := highlightTexts(held, q.Synonyms)
	partial := highlightTexts(held, q.PartialWords)
	native := C.narsil_highlight_query{
		terms:         pinned(held, terms),
		term_count:    C.size_t(len(terms)),
		prefix_length: C.uint32_t(q.PrefixLength),
		synonyms:      pinned(held, synonyms),
		synonym_count: C.size_t(len(synonyms)),
		partial_words: pinned(held, partial),
		partial_count: C.size_t(len(partial)),
	}
	if q.HasPrefix {
		native.prefix = highlightText(held, q.Prefix)
	}
	return native
}

func (w *Workspace) Highlight(analyser *Analyser, request *HighlightRequest, output *HighlightOutput) (HighlightOutcome, error) {
	if analyser == nil || request.Language >= LanguageCount() || !request.Query.fits() ||
		!queryTextsFit(request.Text, request.PreTag, request.PostTag) {
		return HighlightOutcome{}, &StatusError{Operation: "highlight", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_highlight_request{
		language: C.uint32_t(request.Language),
		text:     highlightText(&held, request.Text),
		query:    request.Query.native(&held),
		pre_tag:  highlightText(&held, request.PreTag),
		post_tag: highlightText(&held, request.PostTag),
		maximum:  C.uint32_t(request.MaxSnippetLength),
	}
	snippetLength := make([]C.uint32_t, 1)
	out := C.narsil_highlight_output{
		snippet:          (*C.uint16_t)(pinned(&held, output.Snippet)),
		snippet_capacity: C.size_t(len(output.Snippet)),
		positions:        (*C.uint32_t)(pinned(&held, output.Positions)),
		position_words:   C.size_t(len(output.Positions)),
		snippet_length:   pinned(&held, snippetLength),
		length_capacity:  C.size_t(len(snippetLength)),
	}
	var count C.uint32_t
	status := C.narsil_highlight(analyser.resources.analyser, w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	runtime.KeepAlive(analyser)
	if err := statusError("highlight", status); err != nil {
		return HighlightOutcome{}, err
	}
	return HighlightOutcome{Count: uint32(count), SnippetLength: uint32(snippetLength[0])}, nil
}
