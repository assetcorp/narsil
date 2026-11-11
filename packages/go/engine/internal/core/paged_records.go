package core

/*
#include "native/include/narsil_paged.h"
*/
import "C"

import "runtime"

func (w *Workspace) ReadPagedWriteRecord(cache *PageCache, request PagedWriteRequest) (PagedWriteRecord, error) {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return PagedWriteRecord{}, err
	}
	sections, err := call.sections(&request.Sequences, &request.Terms)
	if err != nil {
		return PagedWriteRecord{}, err
	}
	native := C.narsil_paged_write_request{sequences: &sections[0], terms: &sections[1], ordinal: C.uint32_t(request.Ordinal)}
	out := C.narsil_paged_write_output{values: &call.results.words[0], capacity: C.size_t(len(call.results.words))}
	status := C.narsil_read_paged_write_record(w.pointer(), call.cache, native, out, &call.results.fault)
	runtime.KeepAlive(w)
	if err := pagedStatusError("readPagedWriteRecord", status, &call.results.fault); err != nil {
		return PagedWriteRecord{}, err
	}
	return PagedWriteRecord{SequenceNumber: uint64(call.results.words[0]), PrimaryTerm: uint64(call.results.words[1])}, nil
}

func (w *Workspace) ReadPagedRemovals(cache *PageCache, list PagedRemovalList, output []uint32) (int, error) {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return 0, err
	}
	sections, err := call.sections(&list.Offsets, &list.Values)
	if err != nil {
		return 0, err
	}
	native := C.narsil_paged_removal_list{
		offsets:     &sections[0],
		values:      &sections[1],
		ordinal:     C.uint32_t(list.Ordinal),
		token_count: C.uint32_t(list.TokenCount),
	}
	out := C.narsil_paged_removal_output{
		values:   (*C.uint32_t)(pinned(&call.held, output)),
		capacity: C.size_t(len(output)),
		count:    &call.results.count,
	}
	status := C.narsil_read_paged_removals(w.pointer(), call.cache, native, out, &call.results.fault)
	runtime.KeepAlive(w)
	if err := pagedStatusError("readPagedRemovals", status, &call.results.fault); err != nil {
		return 0, err
	}
	return int(call.results.count), nil
}

func (w *Workspace) ReadPagedID(cache *PageCache, request PagedIDRequest, output []byte) (int, error) {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return 0, err
	}
	sections, err := call.sections(&request.Offsets, &request.Values)
	if err != nil {
		return 0, err
	}
	native := C.narsil_paged_id_request{offsets: &sections[0], values: &sections[1], ordinal: C.uint32_t(request.Ordinal)}
	out := C.narsil_paged_id_output{
		bytes:    (*C.uint8_t)(pinned(&call.held, output)),
		capacity: C.size_t(len(output)),
		length:   &call.results.count,
	}
	status := C.narsil_read_paged_id(w.pointer(), call.cache, native, out, &call.results.fault)
	runtime.KeepAlive(w)
	if err := pagedStatusError("readPagedID", status, &call.results.fault); err != nil {
		return 0, err
	}
	return int(call.results.count), nil
}
