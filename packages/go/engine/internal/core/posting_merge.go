package core

/*
#include "native/include/narsil_posting_merge.h"
*/
import "C"

import "runtime"

const PostingMergeTotals = 2

type PostingMergeOutput struct {
	Documents       []uint32
	Frequencies     []uint16
	Fields          []uint16
	PositionOffsets []uint32
	Positions       []uint32
	Totals          []float64
}

func (w *Workspace) MergePostings(request *KeywordMergeRequest, output *PostingMergeOutput) (uint32, error) {
	if request == nil || request.RetainedTerms != nil || output == nil ||
		len(output.Frequencies) != len(output.Documents) || len(output.Fields) != len(output.Documents) {
		return 0, segmentRefusal("mergePostings")
	}
	for at := range request.Inputs {
		if request.Inputs[at].Growing != nil {
			return 0, segmentRefusal("mergePostings")
		}
	}
	var held pins
	defer held.release()
	native, ok := request.native(&held)
	if !ok {
		return 0, segmentRefusal("mergePostings")
	}
	target := C.narsil_posting_merge_output{
		documents:         (*C.uint32_t)(pinned(&held, output.Documents)),
		frequencies:       (*C.uint16_t)(pinned(&held, output.Frequencies)),
		fields:            (*C.uint16_t)(pinned(&held, output.Fields)),
		row_capacity:      C.size_t(len(output.Documents)),
		position_offsets:  (*C.uint32_t)(pinned(&held, output.PositionOffsets)),
		offset_capacity:   C.size_t(len(output.PositionOffsets)),
		positions:         (*C.uint32_t)(pinned(&held, output.Positions)),
		position_capacity: C.size_t(len(output.Positions)),
		totals:            (*C.double)(pinned(&held, output.Totals)),
		total_capacity:    C.size_t(len(output.Totals)),
	}
	var count C.uint32_t
	status := C.narsil_merge_postings(w.pointer(), native, &target, &count)
	runtime.KeepAlive(w)
	if err := statusError("mergePostings", status); err != nil {
		return 0, err
	}
	return uint32(count), nil
}
