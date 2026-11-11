package core

/*
#include "native/include/narsil_paged.h"
*/
import "C"

import (
	"fmt"
	"runtime"
)

type PageSection struct {
	File      *PagedFile
	Offset    uint64
	Length    uint64
	PageBytes uint32
	Checksums []byte
}

type PageFault struct {
	File    uint64
	Section uint64
	Page    uint64
}

type PageError struct {
	Operation string
	Status    Status
	Fault     PageFault
}

func (e *PageError) Error() string {
	return fmt.Sprintf("the native search core refused %s with status %s at page %d of the section at byte %d of paged file %d",
		e.Operation, e.Status, e.Fault.Page, e.Fault.Section, e.Fault.File)
}

func (e *PageError) Unwrap() error {
	return &StatusError{Operation: e.Operation, Status: e.Status}
}

func pagedStatusError(operation string, status C.narsil_status, fault *C.narsil_page_fault) error {
	switch Status(status) {
	case StatusPageCorrupt, StatusPageUnreadable, StatusPageInvalid:
		return &PageError{
			Operation: operation,
			Status:    Status(status),
			Fault:     PageFault{File: uint64(fault.file), Section: uint64(fault.section), Page: uint64(fault.page)},
		}
	}
	return statusError(operation, status)
}

type PagedPostingList struct {
	First     uint32
	Count     uint32
	Documents uint32
	Fields    uint32
}

type PagedPositionList struct {
	Offsets PageSection
	Values  PageSection
	First   uint32
	Count   uint32
}

type PagedPositionOutput struct {
	Offsets []uint32
	Values  []uint32
}

type PagedRemovalList struct {
	Offsets    PageSection
	Values     PageSection
	Ordinal    uint32
	TokenCount uint32
}

type PagedIDRequest struct {
	Offsets PageSection
	Values  PageSection
	Ordinal uint32
}

type PagedOrdinalRequest struct {
	Position  uint32
	Documents uint32
}

type PagedTotalsRequest struct {
	First uint32
	Count uint32
}

type PagedWriteRequest struct {
	Sequences PageSection
	Terms     PageSection
	Ordinal   uint32
}

type PagedWriteRecord struct {
	SequenceNumber uint64
	PrimaryTerm    uint64
}

type pagedResults struct {
	fault C.narsil_page_fault
	count C.uint32_t
	words [2]C.uint64_t
}

type pagedCall struct {
	held      pins
	files     heldFiles
	pageCache *PageCache
	cache     *C.narsil_page_cache
	results   *pagedResults
}

func (call *pagedCall) begin(cache *PageCache) error {
	call.results = &pagedResults{}
	pointer, err := cache.pointer()
	if err != nil {
		return err
	}
	call.pageCache = cache
	call.cache = pointer
	return nil
}

func (call *pagedCall) sections(sources ...*PageSection) ([]C.narsil_page_section, error) {
	sections := make([]C.narsil_page_section, len(sources))
	for at, source := range sources {
		section, err := call.files.section(&call.held, source)
		if err != nil {
			return nil, err
		}
		sections[at] = section
	}
	pinned(&call.held, sections)
	return sections, nil
}

func (call *pagedCall) close() {
	call.files.release()
	call.held.release()
	runtime.KeepAlive(call.pageCache)
}
