package core

/*
#include "native/include/narsil_facet_merge.h"
*/
import "C"

import "runtime"

type FacetMergeRequest struct {
	Offsets    []uint32
	Values     []uint32
	Counts     []uint32
	Bounds     []uint32
	ValueRanks []uint32
	Ascending  bool
	HasLimit   bool
	Limit      uint32
}

type FacetMergeOutput struct {
	Values     []uint32
	Counts     []uint32
	ErrorBound []uint32
}

func (w *Workspace) MergeFacets(request *FacetMergeRequest, output *FacetMergeOutput) (uint32, error) {
	if request == nil || output == nil {
		return 0, &StatusError{Operation: "mergeFacets", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_facet_merge_request{
		offsets:      (*C.uint32_t)(pinned(&held, request.Offsets)),
		offset_count: C.size_t(len(request.Offsets)),
		values:       (*C.uint32_t)(pinned(&held, request.Values)),
		value_count:  C.size_t(len(request.Values)),
		counts:       (*C.uint32_t)(pinned(&held, request.Counts)),
		count_count:  C.size_t(len(request.Counts)),
		bounds:       (*C.uint32_t)(pinned(&held, request.Bounds)),
		bound_count:  C.size_t(len(request.Bounds)),
		ranks:        (*C.uint32_t)(pinned(&held, request.ValueRanks)),
		rank_count:   C.size_t(len(request.ValueRanks)),
		ascending:    coreFlag(request.Ascending),
		has_limit:    coreFlag(request.HasLimit),
	}
	if request.HasLimit {
		native.limit = C.uint32_t(request.Limit)
	}
	out := C.narsil_facet_merge_output{
		values:         (*C.uint32_t)(pinned(&held, output.Values)),
		value_capacity: C.size_t(len(output.Values)),
		counts:         (*C.uint32_t)(pinned(&held, output.Counts)),
		count_capacity: C.size_t(len(output.Counts)),
		bound:          (*C.uint32_t)(pinned(&held, output.ErrorBound)),
		bound_capacity: C.size_t(len(output.ErrorBound)),
	}
	status := C.narsil_merge_facets(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("mergeFacets", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
