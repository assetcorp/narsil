package core

/*
#include "native/include/narsil_paged.h"
*/
import "C"

import "runtime"

func (w *Workspace) ReadPage(cache *PageCache, section PageSection, page uint64, output []byte) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return err
	}
	sections, err := call.sections(&section)
	if err != nil {
		return err
	}
	status := C.narsil_read_page(w.pointer(), call.cache, &sections[0], C.uint64_t(page),
		(*C.uint8_t)(pinned(&call.held, output)), C.size_t(len(output)), &call.results.fault)
	runtime.KeepAlive(w)
	return pagedStatusError("readPage", status, &call.results.fault)
}

func (w *Workspace) ReadPagedPostings(cache *PageCache, section PageSection, list PagedPostingList, output []byte) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return err
	}
	sections, err := call.sections(&section)
	if err != nil {
		return err
	}
	native := C.narsil_paged_posting_list{
		first:     C.uint32_t(list.First),
		count:     C.uint32_t(list.Count),
		documents: C.uint32_t(list.Documents),
		fields:    C.uint32_t(list.Fields),
	}
	status := C.narsil_read_paged_postings(w.pointer(), call.cache, &sections[0], native,
		(*C.uint8_t)(pinned(&call.held, output)), C.size_t(len(output)), &call.results.fault)
	runtime.KeepAlive(w)
	return pagedStatusError("readPagedPostings", status, &call.results.fault)
}

func (w *Workspace) ReadPagedPositions(cache *PageCache, list PagedPositionList, output PagedPositionOutput) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return err
	}
	sections, err := call.sections(&list.Offsets, &list.Values)
	if err != nil {
		return err
	}
	native := C.narsil_paged_position_list{
		offsets: &sections[0],
		values:  &sections[1],
		first:   C.uint32_t(list.First),
		count:   C.uint32_t(list.Count),
	}
	out := C.narsil_paged_position_output{
		offsets:         (*C.uint32_t)(pinned(&call.held, output.Offsets)),
		offset_capacity: C.size_t(len(output.Offsets)),
		values:          (*C.uint32_t)(pinned(&call.held, output.Values)),
		value_capacity:  C.size_t(len(output.Values)),
	}
	status := C.narsil_read_paged_positions(w.pointer(), call.cache, native, out, &call.results.fault)
	runtime.KeepAlive(w)
	return pagedStatusError("readPagedPositions", status, &call.results.fault)
}

func (w *Workspace) ReadPagedOrdinal(cache *PageCache, section PageSection, request PagedOrdinalRequest) (uint32, error) {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return 0, err
	}
	sections, err := call.sections(&section)
	if err != nil {
		return 0, err
	}
	native := C.narsil_paged_ordinal_request{position: C.uint32_t(request.Position), documents: C.uint32_t(request.Documents)}
	status := C.narsil_read_paged_ordinal(w.pointer(), call.cache, &sections[0], native, &call.results.count, 1, &call.results.fault)
	runtime.KeepAlive(w)
	if err := pagedStatusError("readPagedOrdinal", status, &call.results.fault); err != nil {
		return 0, err
	}
	return uint32(call.results.count), nil
}

func (w *Workspace) ReadPagedTotals(cache *PageCache, section PageSection, request PagedTotalsRequest, output []float64) error {
	var call pagedCall
	defer call.close()
	if err := call.begin(cache); err != nil {
		return err
	}
	sections, err := call.sections(&section)
	if err != nil {
		return err
	}
	native := C.narsil_paged_totals_request{first: C.uint32_t(request.First), count: C.uint32_t(request.Count)}
	status := C.narsil_read_paged_totals(w.pointer(), call.cache, &sections[0], native,
		(*C.double)(pinned(&call.held, output)), C.size_t(len(output)), &call.results.fault)
	runtime.KeepAlive(w)
	return pagedStatusError("readPagedTotals", status, &call.results.fault)
}
