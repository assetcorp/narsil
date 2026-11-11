package core

/*
#include "native/include/narsil_merges.h"
*/
import "C"

import "runtime"

type RankingMergeRequest struct {
	Offsets []uint32
	Scores  []float64
	IDRanks []uint32
	Limit   uint32
}

type SortedMergeRequest struct {
	Offsets []uint32
	Ranks   []uint32
	Limit   uint32
}

type MergeOutput struct {
	Lists   []uint32
	Indices []uint32
}

func (output *MergeOutput) native(held *pins) C.narsil_merge_output {
	return C.narsil_merge_output{
		lists:          (*C.uint32_t)(pinned(held, output.Lists)),
		list_capacity:  C.size_t(len(output.Lists)),
		indices:        (*C.uint32_t)(pinned(held, output.Indices)),
		index_capacity: C.size_t(len(output.Indices)),
	}
}

func (w *Workspace) MergeRankings(request *RankingMergeRequest, output *MergeOutput) (uint32, error) {
	if request == nil || output == nil {
		return 0, &StatusError{Operation: "mergeRankings", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_merge_request{
		offsets:      (*C.uint32_t)(pinned(&held, request.Offsets)),
		offset_count: C.size_t(len(request.Offsets)),
		scores:       (*C.double)(pinned(&held, request.Scores)),
		score_count:  C.size_t(len(request.Scores)),
		ranks:        (*C.uint32_t)(pinned(&held, request.IDRanks)),
		rank_count:   C.size_t(len(request.IDRanks)),
		limit:        C.uint32_t(request.Limit),
	}
	out := output.native(&held)
	status := C.narsil_merge_rankings(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("mergeRankings", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}

func (w *Workspace) MergeSorted(request *SortedMergeRequest, output *MergeOutput) (uint32, error) {
	if request == nil || output == nil {
		return 0, &StatusError{Operation: "mergeSorted", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_merge_request{
		offsets:      (*C.uint32_t)(pinned(&held, request.Offsets)),
		offset_count: C.size_t(len(request.Offsets)),
		ranks:        (*C.uint32_t)(pinned(&held, request.Ranks)),
		rank_count:   C.size_t(len(request.Ranks)),
		limit:        C.uint32_t(request.Limit),
	}
	out := output.native(&held)
	status := C.narsil_merge_sorted(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("mergeSorted", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
