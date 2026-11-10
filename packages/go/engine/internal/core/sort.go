package core

/*
#include "native/include/narsil_sort.h"
*/
import "C"

import "runtime"

type SortMode uint32

const (
	SortMin    SortMode = C.NARSIL_SORT_MIN
	SortMax    SortMode = C.NARSIL_SORT_MAX
	SortAvg    SortMode = C.NARSIL_SORT_AVG
	SortMedian SortMode = C.NARSIL_SORT_MEDIAN
)

type SortKind uint8

const (
	SortMissing SortKind = C.NARSIL_SORT_MISSING
	SortNumber  SortKind = C.NARSIL_SORT_NUMBER
	SortString  SortKind = C.NARSIL_SORT_STRING
	SortFalse   SortKind = C.NARSIL_SORT_FALSE
	SortTrue    SortKind = C.NARSIL_SORT_TRUE
)

const (
	SortValueNumberCapacity = 1
	SortValueTextCapacity   = 2
	SortValueTextStartSlot  = 0
	SortValueTextLengthSlot = 1
)

func (w *Workspace) SortValue(values *StoredValues, ordinal uint32, mode SortMode, number []float64, text []uint32) (SortKind, error) {
	if values == nil {
		return SortMissing, &StatusError{Operation: "sortValue", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := storedValuesForCall(&held, values)
	output := C.narsil_sort_value_output{
		number:          (*C.double)(pinned(&held, number)),
		number_capacity: C.size_t(len(number)),
		text:            (*C.uint32_t)(pinned(&held, text)),
		text_capacity:   C.size_t(len(text)),
	}
	status := C.narsil_sort_value(w.pointer(), &native, C.uint32_t(ordinal), C.uint32_t(mode), &output)
	runtime.KeepAlive(w)
	if err := statusError("sortValue", status); err != nil {
		return SortMissing, err
	}
	return SortKind(output.kind), nil
}
