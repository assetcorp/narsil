package core

/*
#include "native/include/narsil_folding.h"
*/
import "C"

import "runtime"

type FoldedWord struct {
	Key          []uint16
	Own          []uint16
	Excluded     [][]uint16
	Tolerance    uint32
	PrefixLength uint32
}

type FoldedTermsRequest struct {
	Segments []ExpansionSegment
	Tables   []*FoldTable
	Language uint32
	Words    []FoldedWord
}

type FoldedTermsOutput struct {
	Segments []uint32
	Tokens   []uint32
	Starts   []uint32
}

type FoldedPrefixRequest struct {
	Prefix   PrefixExpansionRequest
	Tables   []*FoldTable
	Language uint32
	Folded   []uint16
}

type FoldedPartialWordsRequest struct {
	Partial  PartialWordsRequest
	Tables   []*FoldTable
	Language uint32
	Folded   [][]uint16
}

func nativeTerms(held *pins, texts [][]uint16) ([]C.narsil_term, bool) {
	terms := make([]C.narsil_term, len(texts))
	for at, text := range texts {
		if !queryTextsFit(text) {
			return nil, false
		}
		terms[at] = C.narsil_term{units: (*C.uint16_t)(pinned(held, text)), length: C.uint32_t(len(text))}
	}
	return terms, true
}

func foldedWords(held *pins, words []FoldedWord) ([]C.narsil_folded_word, bool) {
	natives := make([]C.narsil_folded_word, len(words))
	for at := range words {
		word := &words[at]
		if !queryTextsFit(word.Key, word.Own) {
			return nil, false
		}
		excluded, ok := nativeTerms(held, word.Excluded)
		if !ok {
			return nil, false
		}
		natives[at] = C.narsil_folded_word{
			key:            (*C.uint16_t)(pinned(held, word.Key)),
			key_length:     C.size_t(len(word.Key)),
			own:            (*C.uint16_t)(pinned(held, word.Own)),
			own_length:     C.size_t(len(word.Own)),
			excluded:       pinned(held, excluded),
			excluded_count: C.size_t(len(excluded)),
			tolerance:      C.uint32_t(word.Tolerance),
			prefix_length:  C.uint32_t(word.PrefixLength),
		}
	}
	return natives, true
}

func invalidFolded(operation string) error {
	return &StatusError{Operation: operation, Status: StatusInvalidArgument}
}

func (w *Workspace) ExpandFoldedTerms(request *FoldedTermsRequest, output *FoldedTermsOutput) (uint32, error) {
	var held pins
	defer held.release()
	segments, segmentsValid := expansionSegments(&held, request.Segments)
	words, wordsValid := foldedWords(&held, request.Words)
	if !segmentsValid || !wordsValid {
		return 0, invalidFolded("expandFoldedTerms")
	}
	tables, err := holdFoldTables(w, request.Tables, segments, request.Language)
	if err != nil {
		return 0, err
	}
	defer tables.release()
	native := C.narsil_folded_request{
		segments:      pinned(&held, segments),
		tables:        pinned(&held, tables.pointers),
		segment_count: C.size_t(len(segments)),
		words:         pinned(&held, words),
		word_count:    C.size_t(len(words)),
	}
	out := C.narsil_folded_output{
		segments:         (*C.uint32_t)(pinned(&held, output.Segments)),
		segment_capacity: C.size_t(len(output.Segments)),
		tokens:           (*C.uint32_t)(pinned(&held, output.Tokens)),
		token_capacity:   C.size_t(len(output.Tokens)),
		starts:           (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity:   C.size_t(len(output.Starts)),
	}
	var count C.uint32_t
	status := C.narsil_expand_folded_terms(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("expandFoldedTerms", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}

func (w *Workspace) ExpandFoldedPrefix(request *FoldedPrefixRequest, output *ExpansionOutput) (uint32, error) {
	prefix := &request.Prefix
	if !queryTextsFit(prefix.Typed, prefix.Stemmed, prefix.Own, request.Folded) {
		return 0, invalidFolded("expandFoldedPrefix")
	}
	var held pins
	defer held.release()
	segments, ok := expansionSegments(&held, prefix.Segments)
	if !ok {
		return 0, invalidFolded("expandFoldedPrefix")
	}
	tables, err := holdFoldTables(w, request.Tables, segments, request.Language)
	if err != nil {
		return 0, err
	}
	defer tables.release()
	native := C.narsil_folded_prefix_request{
		prefix: C.narsil_prefix_request{
			segments:       pinned(&held, segments),
			segment_count:  C.size_t(len(segments)),
			typed:          (*C.uint16_t)(pinned(&held, prefix.Typed)),
			typed_length:   C.size_t(len(prefix.Typed)),
			stemmed:        (*C.uint16_t)(pinned(&held, prefix.Stemmed)),
			stemmed_length: C.size_t(len(prefix.Stemmed)),
			own:            (*C.uint16_t)(pinned(&held, prefix.Own)),
			own_length:     C.size_t(len(prefix.Own)),
		},
		tables:        pinned(&held, tables.pointers),
		folded:        (*C.uint16_t)(pinned(&held, request.Folded)),
		folded_length: C.size_t(len(request.Folded)),
	}
	out := output.native(&held)
	var count C.uint32_t
	status := C.narsil_expand_folded_prefix(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("expandFoldedPrefix", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}

func (w *Workspace) ExpandFoldedPartialWords(request *FoldedPartialWordsRequest, output *PartialWordsOutput) (uint32, error) {
	partial := &request.Partial
	if len(request.Folded) != len(partial.Words) {
		return 0, invalidFolded("expandFoldedPartialWords")
	}
	var held pins
	defer held.release()
	segments, runs, sourcesValid := partialSources(&held, partial.Sources)
	words, wordsValid := partialWords(&held, partial.Words)
	folded, foldedValid := nativeTerms(&held, request.Folded)
	if !sourcesValid || !wordsValid || !foldedValid {
		return 0, invalidFolded("expandFoldedPartialWords")
	}
	tables, err := holdFoldTables(w, request.Tables, segments, request.Language)
	if err != nil {
		return 0, err
	}
	defer tables.release()
	native := C.narsil_folded_partial_request{
		partial: C.narsil_partial_request{
			segments:      pinned(&held, segments),
			runs:          pinned(&held, runs),
			segment_count: C.size_t(len(segments)),
			words:         pinned(&held, words),
			word_count:    C.size_t(len(words)),
		},
		tables: pinned(&held, tables.pointers),
		folded: pinned(&held, folded),
	}
	out := C.narsil_partial_output{
		additions:      output.Additions.native(&held),
		starts:         (*C.uint32_t)(pinned(&held, output.Starts)),
		start_capacity: C.size_t(len(output.Starts)),
	}
	var count C.uint32_t
	status := C.narsil_expand_folded_partial_words(w.pointer(), &native, &out, &count)
	runtime.KeepAlive(w)
	if err := statusError("expandFoldedPartialWords", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
