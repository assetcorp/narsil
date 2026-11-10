package core

/*
#include "native/include/narsil_pages.h"
*/
import "C"

type PageRequest struct {
	Count           uint32
	Sorted          bool
	HasScores       bool
	Scores          []float64
	HasScorePresent bool
	ScorePresent    []uint32
	AfterAnchor     []uint32
	HasAnchorScore  bool
	AnchorScore     float64
}

func PageStart(request *PageRequest) (uint32, error) {
	if request == nil || (!request.HasScores && len(request.Scores) > 0) ||
		(!request.HasScorePresent && len(request.ScorePresent) > 0) ||
		(request.HasScorePresent && (!request.HasScores || len(request.ScorePresent) == 0)) {
		return 0, &StatusError{Operation: "pageStart", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native := C.narsil_page_request{
		count:                C.uint32_t(request.Count),
		sorted:               coreFlag(request.Sorted),
		has_scores:           coreFlag(request.HasScores),
		has_anchor_score:     coreFlag(request.HasAnchorScore),
		scores:               (*C.double)(pinned(&held, request.Scores)),
		scores_length:        C.size_t(len(request.Scores)),
		score_present:        (*C.uint32_t)(pinned(&held, request.ScorePresent)),
		score_present_length: C.size_t(len(request.ScorePresent)),
		after_anchor:         (*C.uint32_t)(pinned(&held, request.AfterAnchor)),
		after_anchor_length:  C.size_t(len(request.AfterAnchor)),
	}
	if request.HasAnchorScore {
		native.anchor_score = C.double(request.AnchorScore)
	}
	var start C.uint32_t
	if err := statusError("pageStart", C.narsil_page_start(&native, &start)); err != nil {
		return 0, err
	}
	return uint32(start), nil
}
