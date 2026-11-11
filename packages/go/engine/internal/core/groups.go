package core

/*
#include "native/include/narsil_groups.h"
*/
import "C"

import "runtime"

type GroupRequest struct {
	Values      []StoredValues
	Ordinals    []uint32
	Scores      []float64
	IDRanks     []uint32
	MaxPerGroup uint32
	HasLimit    bool
	Limit       uint32
}

type GroupOutput struct {
	Heads   []uint32
	Offsets []uint32
	Hits    []uint32
	Members []uint32
}

func (w *Workspace) GroupHits(request *GroupRequest, output *GroupOutput) (uint32, error) {
	if request == nil || output == nil {
		return 0, &StatusError{Operation: "groupHits", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	values := make([]C.narsil_stored_values, len(request.Values))
	for at := range request.Values {
		values[at] = storedValuesForCall(&held, &request.Values[at])
	}
	native := C.narsil_group_request{
		values:        pinned(&held, values),
		value_count:   C.size_t(len(values)),
		ordinals:      (*C.uint32_t)(pinned(&held, request.Ordinals)),
		ordinal_count: C.size_t(len(request.Ordinals)),
		scores:        (*C.double)(pinned(&held, request.Scores)),
		score_count:   C.size_t(len(request.Scores)),
		id_ranks:      (*C.uint32_t)(pinned(&held, request.IDRanks)),
		id_rank_count: C.size_t(len(request.IDRanks)),
		max_per_group: C.uint32_t(request.MaxPerGroup),
		has_limit:     coreFlag(request.HasLimit),
	}
	if request.HasLimit {
		native.limit = C.uint32_t(request.Limit)
	}
	out := C.narsil_group_output{
		heads:           (*C.uint32_t)(pinned(&held, output.Heads)),
		head_capacity:   C.size_t(len(output.Heads)),
		offsets:         (*C.uint32_t)(pinned(&held, output.Offsets)),
		offset_capacity: C.size_t(len(output.Offsets)),
		hits:            (*C.uint32_t)(pinned(&held, output.Hits)),
		hit_capacity:    C.size_t(len(output.Hits)),
		members:         (*C.uint32_t)(pinned(&held, output.Members)),
		member_capacity: C.size_t(len(output.Members)),
	}
	status := C.narsil_group_hits(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("groupHits", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
