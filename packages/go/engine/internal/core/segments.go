package core

/*
#include "native/include/narsil_segments.h"
*/
import "C"

import "runtime"

func (w *Workspace) IndexTerms(segment *GrowingSegment, ordinal uint32, fields []FieldTokens) error {
	return w.writeDocument("indexTerms", segment, ordinal, fields)
}

func (w *Workspace) RemoveDocument(segment *GrowingSegment, ordinal uint32, fields []FieldTokens) error {
	return w.writeDocument("removeDocument", segment, ordinal, fields)
}

func (w *Workspace) writeDocument(operation string, segment *GrowingSegment, ordinal uint32, fields []FieldTokens) error {
	var held pins
	defer held.release()
	holder, ok := segment.native(&held)
	if !ok {
		return segmentRefusal(operation)
	}
	natives, ok := nativeFieldTokens(&held, fields)
	if !ok {
		return segmentRefusal(operation)
	}
	request := C.narsil_index_terms_request{
		segment:     &holder.segment,
		ordinal:     C.uint32_t(ordinal),
		fields:      natives,
		field_count: C.size_t(len(fields)),
	}
	var status C.narsil_status
	if operation == "removeDocument" {
		status = C.narsil_remove_document(w.pointer(), &request)
	} else {
		status = C.narsil_index_terms(w.pointer(), &request)
	}
	runtime.KeepAlive(w)
	return statusError(operation, status)
}

func (w *Workspace) BeginBatch(segment *GrowingSegment) error {
	return w.markBatch("beginBatch", segment)
}

func (w *Workspace) EndBatch(segment *GrowingSegment) error {
	return w.markBatch("endBatch", segment)
}

func (w *Workspace) markBatch(operation string, segment *GrowingSegment) error {
	var held pins
	defer held.release()
	holder, ok := segment.native(&held)
	if !ok {
		return segmentRefusal(operation)
	}
	var status C.narsil_status
	if operation == "endBatch" {
		status = C.narsil_end_batch(w.pointer(), &holder.segment)
	} else {
		status = C.narsil_begin_batch(w.pointer(), &holder.segment)
	}
	runtime.KeepAlive(w)
	return statusError(operation, status)
}

func (s *GrowingSegment) Dictionary() *TermDictionary {
	return &TermDictionary{Growing: &s.Terms, Frequencies: s.Columns.DocFrequency, Removed: s.Columns.DeadDocuments}
}
