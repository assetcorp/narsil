package core

/*
#include "native/include/narsil_frozen_segments.h"
*/
import "C"

import "runtime"

const FrozenRemovalEntryWords = 2

type FrozenRemovalOutput struct {
	Entries []uint32
	Values  []float64
}

func frozenRemovalRequest(call *pagedCall, operation string, segment *FrozenSegment, state *FrozenSegmentState,
	ordinal uint32, fields []FieldTokens, paged *FrozenPagedRemovals) (*C.narsil_remove_frozen_request, error) {
	holder, ok := nativeFrozen(&call.held, segment, state)
	if !ok {
		return nil, segmentRefusal(operation)
	}
	removals, err := paged.native(call, holder)
	if err != nil {
		return nil, err
	}
	natives, ok := nativeFieldTokens(&call.held, fields)
	if !ok {
		return nil, segmentRefusal(operation)
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
	request, err := frozenRemovalRequest(&call, "removeFrozenDocument", segment, state, ordinal, fields, paged)
	if err != nil {
		return err
	}
	status := C.narsil_remove_frozen_document(w.pointer(), request)
	runtime.KeepAlive(w)
	return pagedStatusError("removeFrozenDocument", status, &call.results.fault)
}

func (w *Workspace) PrepareFrozenRemoval(segment *FrozenSegment, state *FrozenSegmentState, ordinal uint32,
	fields []FieldTokens, paged *FrozenPagedRemovals, output *FrozenRemovalOutput) (int, error) {
	if output == nil || len(output.Entries)%FrozenRemovalEntryWords != 0 {
		return 0, segmentRefusal("prepareFrozenRemoval")
	}
	var call pagedCall
	defer call.close()
	if err := call.begin(paged.cache()); err != nil {
		return 0, err
	}
	request, err := frozenRemovalRequest(&call, "prepareFrozenRemoval", segment, state, ordinal, fields, paged)
	if err != nil {
		return 0, err
	}
	native := C.narsil_frozen_removal_output{
		entries:        (*C.uint32_t)(pinned(&call.held, output.Entries)),
		values:         (*C.double)(pinned(&call.held, output.Values)),
		entry_capacity: C.size_t(len(output.Entries) / FrozenRemovalEntryWords),
		value_capacity: C.size_t(len(output.Values)),
	}
	var count C.size_t
	status := C.narsil_prepare_frozen_removal(w.pointer(), request, &native, &count)
	runtime.KeepAlive(w)
	if err := pagedStatusError("prepareFrozenRemoval", status, &call.results.fault); err != nil {
		return 0, err
	}
	return int(count), nil
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
