package core

/*
#include "native/include/narsil_pinned.h"
*/
import "C"

import (
	"math"
	"runtime"
)

const PinnedAbsentFromRanking int32 = -1

type PinnedRequest struct {
	Count     uint32
	Ranked    []int32
	Positions []uint32
	HasDepth  bool
	Depth     uint32
}

func (w *Workspace) PlacePinned(request *PinnedRequest, entries []int32) (uint32, error) {
	if request == nil || request.Count > math.MaxInt32 || len(request.Ranked) > math.MaxInt32 ||
		len(request.Ranked) != len(request.Positions) {
		return 0, &StatusError{Operation: "placePinned", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_pinned_request{
		count:          C.uint32_t(request.Count),
		ranked:         (*C.int32_t)(pinned(&held, request.Ranked)),
		ranked_count:   C.size_t(len(request.Ranked)),
		positions:      (*C.uint32_t)(pinned(&held, request.Positions)),
		position_count: C.size_t(len(request.Positions)),
		has_depth:      coreFlag(request.HasDepth),
	}
	if request.HasDepth {
		native.depth = C.uint32_t(request.Depth)
	}
	out := C.narsil_pinned_output{
		entries:  (*C.int32_t)(pinned(&held, entries)),
		capacity: C.size_t(len(entries)),
	}
	status := C.narsil_place_pinned(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("placePinned", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
