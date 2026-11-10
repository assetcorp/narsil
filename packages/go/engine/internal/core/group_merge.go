package core

/*
#include "native/include/narsil_group_merge.h"
*/
import "C"

import "runtime"

type GroupMergeRequest struct {
	Keys            []uint32
	Offsets         []uint32
	HasScores       bool
	Scores          []float64
	HasScorePresent bool
	ScorePresent    []uint32
	Ranks           []uint32
	IDRanks         []uint32
	Sorted          bool
	MaxPerGroup     uint32
	HasLimit        bool
	Limit           uint32
}

type GroupMergeOutput struct {
	Keys    []uint32
	Offsets []uint32
	Sources []uint32
	Indices []uint32
}

func (w *Workspace) MergeGroups(request *GroupMergeRequest, output *GroupMergeOutput) (uint32, error) {
	if request == nil || output == nil || (!request.HasScores && len(request.Scores) > 0) ||
		(!request.HasScorePresent && len(request.ScorePresent) > 0) || (request.HasScorePresent && !request.HasScores) {
		return 0, &StatusError{Operation: "mergeGroups", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_group_merge_request{
		keys:                (*C.uint32_t)(pinned(&held, request.Keys)),
		key_count:           C.size_t(len(request.Keys)),
		offsets:             (*C.uint32_t)(pinned(&held, request.Offsets)),
		offset_count:        C.size_t(len(request.Offsets)),
		scores:              (*C.double)(pinned(&held, request.Scores)),
		score_count:         C.size_t(len(request.Scores)),
		score_present:       (*C.uint32_t)(pinned(&held, request.ScorePresent)),
		score_present_count: C.size_t(len(request.ScorePresent)),
		ranks:               (*C.uint32_t)(pinned(&held, request.Ranks)),
		rank_count:          C.size_t(len(request.Ranks)),
		id_ranks:            (*C.uint32_t)(pinned(&held, request.IDRanks)),
		id_rank_count:       C.size_t(len(request.IDRanks)),
		has_scores:          coreFlag(request.HasScores),
		has_score_present:   coreFlag(request.HasScorePresent),
		sorted:              coreFlag(request.Sorted),
		max_per_group:       C.uint32_t(request.MaxPerGroup),
		has_limit:           coreFlag(request.HasLimit),
	}
	if request.HasLimit {
		native.limit = C.uint32_t(request.Limit)
	}
	out := C.narsil_group_merge_output{
		keys:            (*C.uint32_t)(pinned(&held, output.Keys)),
		key_capacity:    C.size_t(len(output.Keys)),
		offsets:         (*C.uint32_t)(pinned(&held, output.Offsets)),
		offset_capacity: C.size_t(len(output.Offsets)),
		sources:         (*C.uint32_t)(pinned(&held, output.Sources)),
		source_capacity: C.size_t(len(output.Sources)),
		indices:         (*C.uint32_t)(pinned(&held, output.Indices)),
		index_capacity:  C.size_t(len(output.Indices)),
	}
	status := C.narsil_merge_groups(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("mergeGroups", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
