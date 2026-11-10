package core

/*
#include "native/include/narsil_facets.h"
*/
import "C"

import "runtime"

const (
	BooleanFacetTrueSlot  = 0
	BooleanFacetFalseSlot = 1
	BooleanFacetCounts    = 2
)

func numericFacetInput(held *pins, index *NumericIndex, matched []uint32) C.narsil_numeric_facet_input {
	return C.narsil_numeric_facet_input{
		values:        (*C.double)(pinned(held, index.Values)),
		count:         C.size_t(len(index.Values)),
		ordinals:      (*C.uint32_t)(pinned(held, index.Ordinals)),
		ordinal_count: C.size_t(len(index.Ordinals)),
		matched:       (*C.uint32_t)(pinned(held, matched)),
		matched_words: C.size_t(len(matched)),
	}
}

func BooleanFacet(index *BooleanIndex, matched, counts []uint32) error {
	if index == nil {
		return &StatusError{Operation: "booleanFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_boolean_index{
		true_bits:   (*C.uint32_t)(pinned(&held, index.TrueBits)),
		true_words:  C.size_t(len(index.TrueBits)),
		false_bits:  (*C.uint32_t)(pinned(&held, index.FalseBits)),
		false_words: C.size_t(len(index.FalseBits)),
	}
	status := C.narsil_boolean_facet(&native, (*C.uint32_t)(pinned(&held, matched)), C.size_t(len(matched)),
		(*C.uint32_t)(pinned(&held, counts)), C.size_t(len(counts)))
	return statusError("booleanFacet", status)
}

func (w *Workspace) EnumFacet(index *EnumIndex, matched, counts []uint32) error {
	if index == nil {
		return &StatusError{Operation: "enumFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	status := C.narsil_enum_facet(w.pointer(),
		(*C.uint32_t)(pinned(&held, index.PostingOffsets)), C.size_t(len(index.PostingOffsets)),
		(*C.uint32_t)(pinned(&held, index.Postings)), C.size_t(len(index.Postings)),
		(*C.uint32_t)(pinned(&held, matched)), C.size_t(len(matched)),
		(*C.uint32_t)(pinned(&held, counts)), C.size_t(len(counts)))
	runtime.KeepAlive(w)
	return statusError("enumFacet", status)
}

func (w *Workspace) NumberFacet(index *NumericIndex, matched []uint32, values []float64, counts []uint32) (uint32, error) {
	if index == nil {
		return 0, &StatusError{Operation: "numberFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	input := numericFacetInput(&held, index, matched)
	output := C.narsil_number_facet_output{
		values:         (*C.double)(pinned(&held, values)),
		value_capacity: C.size_t(len(values)),
		counts:         (*C.uint32_t)(pinned(&held, counts)),
		count_capacity: C.size_t(len(counts)),
	}
	var count C.uint32_t
	status := C.narsil_number_facet(w.pointer(), &input, &output, &count)
	runtime.KeepAlive(w)
	if err := statusError("numberFacet", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}

func (w *Workspace) RangeFacet(index *NumericIndex, matched []uint32, ranges []float64, counts []uint32) error {
	if index == nil {
		return &StatusError{Operation: "rangeFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	input := numericFacetInput(&held, index, matched)
	status := C.narsil_range_facet(w.pointer(), &input, (*C.double)(pinned(&held, ranges)), C.size_t(len(ranges)),
		(*C.uint32_t)(pinned(&held, counts)), C.size_t(len(counts)))
	runtime.KeepAlive(w)
	return statusError("rangeFacet", status)
}

func StoredRangeFacet(values *StoredValues, matched []uint32, ranges []float64, counts []uint32) error {
	if values == nil {
		return &StatusError{Operation: "storedRangeFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := storedValuesForCall(&held, values)
	status := C.narsil_stored_range_facet(&native, (*C.uint32_t)(pinned(&held, matched)), C.size_t(len(matched)),
		(*C.double)(pinned(&held, ranges)), C.size_t(len(ranges)),
		(*C.uint32_t)(pinned(&held, counts)), C.size_t(len(counts)))
	return statusError("storedRangeFacet", status)
}

func (w *Workspace) ValueFacet(values *StoredValues, matched, firstValues, counts []uint32) (uint32, error) {
	if values == nil {
		return 0, &StatusError{Operation: "valueFacet", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := storedValuesForCall(&held, values)
	output := C.narsil_value_facet_output{
		values:         (*C.uint32_t)(pinned(&held, firstValues)),
		value_capacity: C.size_t(len(firstValues)),
		counts:         (*C.uint32_t)(pinned(&held, counts)),
		count_capacity: C.size_t(len(counts)),
	}
	var count C.uint32_t
	status := C.narsil_value_facet(w.pointer(), &native, (*C.uint32_t)(pinned(&held, matched)), C.size_t(len(matched)),
		&output, &count)
	runtime.KeepAlive(w)
	if err := statusError("valueFacet", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
