package core

/*
#include "native/include/narsil_sort_select.h"
*/
import "C"

import "runtime"

const (
	SortAscending  uint8 = 0
	SortDescending uint8 = 1
)

type SortSelectRequest struct {
	Columns      []SortColumn
	Directions   []uint8
	Filter       []uint32
	Live         []uint32
	Limit        uint32
	HasAnchor    bool
	AnchorRanks  []int32
	AnchorValues SortValues
	Output       []uint32
}

func (w *Workspace) SortSelect(request *SortSelectRequest) (uint32, error) {
	if request == nil || len(request.Columns) == 0 || len(request.Directions) != len(request.Columns) ||
		(!request.HasAnchor && (len(request.AnchorRanks) > 0 || len(request.AnchorValues.Kinds) > 0)) {
		return 0, &StatusError{Operation: "sortSelect", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	columns := make([]C.narsil_sort_column, len(request.Columns))
	for at := range request.Columns {
		columns[at] = request.Columns[at].native(&held)
	}
	native := C.narsil_sort_select_request{
		columns:         pinned(&held, columns),
		column_count:    C.size_t(len(columns)),
		directions:      (*C.uint8_t)(pinned(&held, request.Directions)),
		direction_count: C.size_t(len(request.Directions)),
		filter:          (*C.uint32_t)(pinned(&held, request.Filter)),
		filter_words:    C.size_t(len(request.Filter)),
		live:            (*C.uint32_t)(pinned(&held, request.Live)),
		live_words:      C.size_t(len(request.Live)),
		limit:           C.uint32_t(request.Limit),
		output:          (*C.uint32_t)(pinned(&held, request.Output)),
		output_capacity: C.size_t(len(request.Output)),
	}
	if request.HasAnchor {
		anchor := []C.narsil_sort_values{request.AnchorValues.native(&held)}
		native.anchor_values = pinned(&held, anchor)
		native.anchor_ranks = (*C.int32_t)(pinned(&held, request.AnchorRanks))
		native.anchor_rank_count = C.size_t(len(request.AnchorRanks))
	}
	var count C.uint32_t
	status := C.narsil_sort_select(w.pointer(), &native, &count)
	runtime.KeepAlive(w)
	if err := statusError("sortSelect", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
