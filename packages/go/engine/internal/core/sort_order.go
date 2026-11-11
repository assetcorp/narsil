package core

/*
#include "native/include/narsil_sort_order.h"
*/
import "C"

import "runtime"

const (
	SortOrderCounts             = 2
	SortOrderDistinctSlot       = 0
	SortOrderPresentSlot        = 1
	SortMissingRank       int32 = -1
)

type SortValues struct {
	Kinds      []uint8
	Numbers    []float64
	TextStart  []uint32
	TextLength []uint32
	Units      []uint16
}

type SortColumn struct {
	Current SortValues
	Values  SortValues
	Ranks   []int32
	Ordered []uint32
	Dirty   []uint32
}

type SortOrderOutput struct {
	Values  SortValues
	Ranks   []int32
	Ordered []uint32
	Dirty   []uint32
	Counts  []uint32
}

type TextBound struct {
	Present   bool
	Units     []uint16
	Inclusive bool
}

type TextRangeRequest struct {
	Lower  TextBound
	Upper  TextBound
	Live   []uint32
	Output []uint32
}

func (v *SortValues) native(held *pins) C.narsil_sort_values {
	return C.narsil_sort_values{
		kinds:             (*C.uint8_t)(pinned(held, v.Kinds)),
		count:             C.size_t(len(v.Kinds)),
		numbers:           (*C.double)(pinned(held, v.Numbers)),
		number_count:      C.size_t(len(v.Numbers)),
		text_start:        (*C.uint32_t)(pinned(held, v.TextStart)),
		text_start_count:  C.size_t(len(v.TextStart)),
		text_length:       (*C.uint32_t)(pinned(held, v.TextLength)),
		text_length_count: C.size_t(len(v.TextLength)),
		units:             (*C.uint16_t)(pinned(held, v.Units)),
		unit_count:        C.size_t(len(v.Units)),
	}
}

func (v *SortValues) output(held *pins) C.narsil_sort_values_output {
	return C.narsil_sort_values_output{
		kinds:                (*C.uint8_t)(pinned(held, v.Kinds)),
		capacity:             C.size_t(len(v.Kinds)),
		numbers:              (*C.double)(pinned(held, v.Numbers)),
		number_capacity:      C.size_t(len(v.Numbers)),
		text_start:           (*C.uint32_t)(pinned(held, v.TextStart)),
		text_start_capacity:  C.size_t(len(v.TextStart)),
		text_length:          (*C.uint32_t)(pinned(held, v.TextLength)),
		text_length_capacity: C.size_t(len(v.TextLength)),
		units:                (*C.uint16_t)(pinned(held, v.Units)),
		unit_capacity:        C.size_t(len(v.Units)),
	}
}

func (c *SortColumn) native(held *pins) C.narsil_sort_column {
	return C.narsil_sort_column{
		current:       c.Current.native(held),
		values:        c.Values.native(held),
		ranks:         (*C.int32_t)(pinned(held, c.Ranks)),
		rank_count:    C.size_t(len(c.Ranks)),
		ordered:       (*C.uint32_t)(pinned(held, c.Ordered)),
		ordered_count: C.size_t(len(c.Ordered)),
		dirty:         (*C.uint32_t)(pinned(held, c.Dirty)),
		dirty_words:   C.size_t(len(c.Dirty)),
	}
}

func (b *TextBound) native(held *pins) C.narsil_sort_bound {
	if !b.Present {
		return C.narsil_sort_bound{inclusive: coreFlag(b.Inclusive)}
	}
	return C.narsil_sort_bound{
		units:     (*C.uint16_t)(pinned(held, b.Units)),
		length:    C.size_t(len(b.Units)),
		present:   1,
		inclusive: coreFlag(b.Inclusive),
	}
}

func (w *Workspace) BuildSortOrder(current *SortValues, live []uint32, output *SortOrderOutput) error {
	if current == nil || output == nil {
		return &StatusError{Operation: "buildSortOrder", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := current.native(&held)
	out := C.narsil_sort_order_output{
		values:           output.Values.output(&held),
		ranks:            (*C.int32_t)(pinned(&held, output.Ranks)),
		rank_capacity:    C.size_t(len(output.Ranks)),
		ordered:          (*C.uint32_t)(pinned(&held, output.Ordered)),
		ordered_capacity: C.size_t(len(output.Ordered)),
		dirty:            (*C.uint32_t)(pinned(&held, output.Dirty)),
		dirty_capacity:   C.size_t(len(output.Dirty)),
		counts:           (*C.uint32_t)(pinned(&held, output.Counts)),
		count_capacity:   C.size_t(len(output.Counts)),
	}
	status := C.narsil_build_sort_order(w.pointer(), &native, (*C.uint32_t)(pinned(&held, live)), C.size_t(len(live)), &out)
	runtime.KeepAlive(w)
	return statusError("buildSortOrder", status)
}

func TextRange(column *SortColumn, request *TextRangeRequest) error {
	if column == nil || request == nil || (!request.Lower.Present && len(request.Lower.Units) > 0) ||
		(!request.Upper.Present && len(request.Upper.Units) > 0) {
		return &StatusError{Operation: "textRange", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := column.native(&held)
	bounds := C.narsil_text_range_request{
		lower:        request.Lower.native(&held),
		upper:        request.Upper.native(&held),
		live:         (*C.uint32_t)(pinned(&held, request.Live)),
		live_words:   C.size_t(len(request.Live)),
		output:       (*C.uint32_t)(pinned(&held, request.Output)),
		output_words: C.size_t(len(request.Output)),
	}
	return statusError("textRange", C.narsil_text_range(&native, &bounds))
}
