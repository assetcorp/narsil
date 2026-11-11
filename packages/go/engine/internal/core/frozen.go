package core

/*
#include "native/include/narsil_frozen_segments.h"
*/
import "C"

import "runtime"

const removeFrozenDocumentOperation = "removeFrozenDocument"

func frozenRemovalRequest(call *pagedCall, segment *FrozenSegment, state *FrozenSegmentState,
	ordinal uint32, fields []FieldTokens, paged *FrozenPagedRemovals) (*C.narsil_remove_frozen_request, error) {
	holder, ok := nativeFrozen(&call.held, segment, state)
	if !ok {
		return nil, segmentRefusal(removeFrozenDocumentOperation)
	}
	removals, err := paged.native(call, holder)
	if err != nil {
		return nil, err
	}
	natives, ok := nativeFieldTokens(&call.held, fields)
	if !ok {
		return nil, segmentRefusal(removeFrozenDocumentOperation)
	}
	requests := make([]C.narsil_remove_frozen_request, 1)
	request := pinned(&call.held, requests)
	*request = C.narsil_remove_frozen_request{
		segment:     &holder.segment,
		state:       &holder.state,
		ordinal:     C.uint32_t(ordinal),
		fields:      natives,
		field_count: C.size_t(len(fields)),
		paged:       removals,
	}
	return request, nil
}

func (w *Workspace) RemoveFrozenDocument(segment *FrozenSegment, state *FrozenSegmentState, ordinal uint32,
	fields []FieldTokens, paged *FrozenPagedRemovals) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(paged.cache()); err != nil {
		return err
	}
	request, err := frozenRemovalRequest(&call, segment, state, ordinal, fields, paged)
	if err != nil {
		return err
	}
	status := C.narsil_remove_frozen_document(w.pointer(), request)
	runtime.KeepAlive(w)
	return pagedStatusError(removeFrozenDocumentOperation, status, &call.results.fault)
}

func (w *Workspace) SettleFrozenState(segment *FrozenSegment, state *FrozenSegmentState, paged *FrozenPagedRemovals) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(paged.cache()); err != nil {
		return err
	}
	holder, ok := nativeFrozen(&call.held, segment, state)
	if !ok {
		return segmentRefusal("settleFrozenState")
	}
	removals, err := paged.native(&call, holder)
	if err != nil {
		return err
	}
	status := C.narsil_settle_frozen_state(w.pointer(), &holder.segment, &holder.state, removals)
	runtime.KeepAlive(w)
	return pagedStatusError("settleFrozenState", status, &call.results.fault)
}
