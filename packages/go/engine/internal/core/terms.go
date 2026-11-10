package core

/*
#include "native/include/narsil_terms.h"
*/
import "C"

import (
	"math"
	"runtime"
)

const (
	TermTableHeaderWords = 8
	TermTableFirstUnits  = 1 << 16
	TermAbsent           = math.MaxUint32
)

const (
	TermHeaderCount        = 0
	TermHeaderLiveCount    = 1
	TermHeaderSlotCapacity = 2
	TermHeaderGeneration   = 3
	TermHeaderUnitsUsed    = 4
)

type TermLookupOperation uint32

const (
	TermLookupExact  TermLookupOperation = C.NARSIL_LOOKUP_EXACT
	TermLookupPrefix TermLookupOperation = C.NARSIL_LOOKUP_PREFIX
	TermLookupTypo   TermLookupOperation = C.NARSIL_LOOKUP_TYPO
)

type TermTable struct {
	Header        []uint32
	Slots         []int32
	TermOffset    []uint32
	TermLength    []uint32
	FirstUnitNext []uint32
	FirstUnitHead []uint32
	Units         []uint16
}

func (t *TermTable) native(held *pins) C.narsil_term_table {
	return C.narsil_term_table{
		header:          (*C.uint32_t)(pinned(held, t.Header)),
		header_words:    C.size_t(len(t.Header)),
		slots:           (*C.int32_t)(pinned(held, t.Slots)),
		slot_count:      C.size_t(len(t.Slots)),
		term_offset:     (*C.uint32_t)(pinned(held, t.TermOffset)),
		offset_count:    C.size_t(len(t.TermOffset)),
		term_length:     (*C.uint32_t)(pinned(held, t.TermLength)),
		length_count:    C.size_t(len(t.TermLength)),
		first_unit_next: (*C.uint32_t)(pinned(held, t.FirstUnitNext)),
		next_count:      C.size_t(len(t.FirstUnitNext)),
		first_unit_head: (*C.uint32_t)(pinned(held, t.FirstUnitHead)),
		head_count:      C.size_t(len(t.FirstUnitHead)),
		units:           (*C.uint16_t)(pinned(held, t.Units)),
		unit_count:      C.size_t(len(t.Units)),
	}
}

type TermDictionary struct {
	Growing     *TermTable
	Tokens      []byte
	Offsets     []uint32
	Frequencies []uint32
	Removed     []uint32
}

type termDictionaryNative struct {
	dictionary C.narsil_term_dictionary
	growing    C.narsil_term_table
}

func (d *TermDictionary) native(held *pins) *termDictionaryNative {
	holder := new(termDictionaryNative)
	held.pinner.Pin(holder)
	holder.dictionary = C.narsil_term_dictionary{
		tokens:          (*C.uint8_t)(pinned(held, d.Tokens)),
		token_bytes:     C.size_t(len(d.Tokens)),
		offsets:         (*C.uint32_t)(pinned(held, d.Offsets)),
		offset_count:    C.size_t(len(d.Offsets)),
		frequencies:     (*C.uint32_t)(pinned(held, d.Frequencies)),
		frequency_count: C.size_t(len(d.Frequencies)),
		removed:         (*C.uint32_t)(pinned(held, d.Removed)),
		removed_count:   C.size_t(len(d.Removed)),
	}
	if d.Growing != nil {
		holder.growing = d.Growing.native(held)
		holder.dictionary.growing = &holder.growing
	}
	return holder
}

type TermLookup struct {
	Operation    TermLookupOperation
	Text         []uint16
	Limit        uint32
	Tolerance    uint32
	PrefixLength uint32
}

func (w *Workspace) LookupTerms(dictionary *TermDictionary, lookup TermLookup, ordinals []uint32) (int, error) {
	if dictionary == nil {
		return 0, &StatusError{Operation: "lookupTerms", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	holder := dictionary.native(&held)
	request := C.narsil_term_lookup{
		dictionary:    &holder.dictionary,
		text:          (*C.uint16_t)(pinned(&held, lookup.Text)),
		text_length:   C.size_t(len(lookup.Text)),
		operation:     C.uint32_t(lookup.Operation),
		limit:         C.uint32_t(lookup.Limit),
		tolerance:     C.uint32_t(lookup.Tolerance),
		prefix_length: C.uint32_t(lookup.PrefixLength),
	}
	var count C.uint32_t
	status := C.narsil_lookup_terms(w.pointer(), &request, (*C.uint32_t)(pinned(&held, ordinals)),
		C.size_t(len(ordinals)), &count)
	runtime.KeepAlive(w)
	if err := statusError("lookupTerms", status); err != nil {
		return 0, err
	}
	return int(count), nil
}

func (w *Workspace) LookupExact(dictionary *TermDictionary, term []uint16, ordinals []uint32) (int, error) {
	return w.LookupTerms(dictionary, TermLookup{Operation: TermLookupExact, Text: term}, ordinals)
}

func (w *Workspace) LookupPrefix(dictionary *TermDictionary, prefix []uint16, limit uint32, ordinals []uint32) (int, error) {
	return w.LookupTerms(dictionary, TermLookup{Operation: TermLookupPrefix, Text: prefix, Limit: limit}, ordinals)
}

func (w *Workspace) LookupTypo(dictionary *TermDictionary, term []uint16, tolerance, prefixLength uint32, ordinals []uint32) (int, error) {
	lookup := TermLookup{Operation: TermLookupTypo, Text: term, Tolerance: tolerance, PrefixLength: prefixLength}
	return w.LookupTerms(dictionary, lookup, ordinals)
}

func (w *Workspace) LookupExactBatch(dictionary *TermDictionary, units []uint16, offsets []uint32, ordinals []uint32) (int, error) {
	if dictionary == nil || len(offsets) == 0 || len(ordinals) < len(offsets)-1 {
		return 0, &StatusError{Operation: "lookupExactBatch", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	holder := dictionary.native(&held)
	status := C.narsil_lookup_exact_batch(w.pointer(), &holder.dictionary,
		(*C.uint16_t)(pinned(&held, units)), C.size_t(len(units)),
		(*C.uint32_t)(pinned(&held, offsets)), C.size_t(len(offsets)),
		(*C.uint32_t)(pinned(&held, ordinals)), C.size_t(len(ordinals)))
	runtime.KeepAlive(w)
	if err := statusError("lookupExactBatch", status); err != nil {
		return 0, err
	}
	return len(offsets) - 1, nil
}

func DocumentFrequency(dictionary *TermDictionary, token uint32) (uint32, error) {
	if dictionary == nil {
		return 0, &StatusError{Operation: "documentFrequency", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	holder := dictionary.native(&held)
	var frequency C.uint32_t
	status := C.narsil_document_frequency(&holder.dictionary, C.uint32_t(token), &frequency, 1)
	if err := statusError("documentFrequency", status); err != nil {
		return 0, err
	}
	return uint32(frequency), nil
}
