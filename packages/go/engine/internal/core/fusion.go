package core

/*
#include "native/include/narsil_fusion.h"
*/
import "C"

import (
	"math"
	"runtime"
)

type FusionStrategy uint32

const (
	FusionReciprocalRank FusionStrategy = C.NARSIL_FUSION_RRF
	FusionLinear         FusionStrategy = C.NARSIL_FUSION_LINEAR
)

type FusionLeg struct {
	Keys   []uint32
	Scores []float64
}

type FusionRequest struct {
	Strategy     FusionStrategy
	RankConstant float64
	Alpha        float64
	Text         FusionLeg
	Vector       FusionLeg
	IDRanks      []uint32
}

type FusionOutput struct {
	Keys   []uint32
	Scores []float64
}

func (leg *FusionLeg) native(held *pins) (C.narsil_fusion_leg, bool) {
	if len(leg.Keys) != len(leg.Scores) || len(leg.Keys) > math.MaxUint32 {
		return C.narsil_fusion_leg{}, false
	}
	return C.narsil_fusion_leg{
		keys:   (*C.uint32_t)(pinned(held, leg.Keys)),
		scores: (*C.double)(pinned(held, leg.Scores)),
		count:  C.uint32_t(len(leg.Keys)),
	}, true
}

func (w *Workspace) Fuse(request *FusionRequest, output *FusionOutput) (uint32, error) {
	if request == nil || output == nil || request.Strategy > FusionLinear || len(request.IDRanks) > math.MaxUint32 {
		return 0, &StatusError{Operation: "fuse", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	text, textValid := request.Text.native(&held)
	vector, vectorValid := request.Vector.native(&held)
	if !textValid || !vectorValid {
		return 0, &StatusError{Operation: "fuse", Status: StatusInvalidArgument}
	}
	native := C.narsil_fusion_request{
		strategy:      C.uint32_t(request.Strategy),
		rank_constant: C.double(request.RankConstant),
		alpha:         C.double(request.Alpha),
		text:          text,
		vector:        vector,
		id_ranks:      (*C.uint32_t)(pinned(&held, request.IDRanks)),
		key_count:     C.uint32_t(len(request.IDRanks)),
	}
	out := C.narsil_fusion_output{
		keys:     (*C.uint32_t)(pinned(&held, output.Keys)),
		scores:   (*C.double)(pinned(&held, output.Scores)),
		capacity: uint32Length(min(len(output.Keys), len(output.Scores))),
	}
	status := C.narsil_fuse(w.pointer(), &native, &out)
	runtime.KeepAlive(w)
	if err := statusError("fuse", status); err != nil {
		return 0, err
	}
	return uint32(out.count), nil
}
