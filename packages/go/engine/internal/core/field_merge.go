package core

/*
#include "native/include/narsil_field_merge.h"
*/
import "C"

import "runtime"

type FieldMergeKind uint32

const (
	FieldMergeNumeric FieldMergeKind = C.NARSIL_MERGE_NUMERIC
	FieldMergeBoolean FieldMergeKind = C.NARSIL_MERGE_BOOLEAN
	FieldMergeEnum    FieldMergeKind = C.NARSIL_MERGE_ENUM
	FieldMergeGeo     FieldMergeKind = C.NARSIL_MERGE_GEO
	FieldMergeStored  FieldMergeKind = C.NARSIL_MERGE_STORED
	FieldMergePattern FieldMergeKind = C.NARSIL_MERGE_PATTERN
)

const FieldMergeRegionCount = C.NARSIL_FIELD_MERGE_REGIONS

type FieldMergeSource struct {
	Mapping []uint32
	Index   FieldIndex
}

type FieldMergeRequest struct {
	Kind          FieldMergeKind
	DocumentCount uint32
	Sources       []FieldMergeSource
}

type FieldMergeSizes [FieldMergeRegionCount]uint32

func (request *FieldMergeRequest) native(held *pins) (C.narsil_field_merge_request, bool) {
	sources := make([]C.narsil_field_merge_source, len(request.Sources))
	for at := range request.Sources {
		source := &request.Sources[at]
		if source.Index == nil {
			return C.narsil_field_merge_request{}, false
		}
		regions := source.Index.fieldIndexRegions()
		if regions.kind != request.Kind {
			return C.narsil_field_merge_request{}, false
		}
		sources[at].mapping = (*C.uint32_t)(pinned(held, source.Mapping))
		sources[at].document_count = C.size_t(len(source.Mapping))
		for region := range regions.count {
			sources[at].regions[region] = C.narsil_field_merge_region{
				data:   regions.regions[region].pinnedData(held),
				length: C.size_t(regions.regions[region].length),
			}
		}
	}
	return C.narsil_field_merge_request{
		kind:           C.uint32_t(request.Kind),
		document_count: C.uint32_t(request.DocumentCount),
		sources:        pinned(held, sources),
		source_count:   C.size_t(len(sources)),
	}, true
}

func (w *Workspace) MeasureFieldMerge(request *FieldMergeRequest) (FieldMergeSizes, error) {
	if request == nil {
		return FieldMergeSizes{}, &StatusError{Operation: "measureFieldMerge", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native, valid := request.native(&held)
	if !valid {
		return FieldMergeSizes{}, &StatusError{Operation: "measureFieldMerge", Status: StatusInvalidArgument}
	}
	var sizes C.narsil_field_merge_sizes
	status := C.narsil_measure_field_merge(w.pointer(), &native, &sizes)
	runtime.KeepAlive(w)
	if err := statusError("measureFieldMerge", status); err != nil {
		return FieldMergeSizes{}, err
	}
	var measured FieldMergeSizes
	for at := range measured {
		measured[at] = uint32(sizes.lengths[at])
	}
	return measured, nil
}

func (w *Workspace) WriteFieldMerge(request *FieldMergeRequest, target FieldIndex) error {
	if request == nil || target == nil {
		return &StatusError{Operation: "writeFieldMerge", Status: StatusInvalidArgument}
	}
	targets := target.fieldIndexRegions()
	if targets.kind != request.Kind {
		return &StatusError{Operation: "writeFieldMerge", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	native, valid := request.native(&held)
	if !valid {
		return &StatusError{Operation: "writeFieldMerge", Status: StatusInvalidArgument}
	}
	var output C.narsil_field_merge_output
	for region := range targets.count {
		output.regions[region] = C.narsil_field_merge_target{
			data:     targets.regions[region].pinnedData(&held),
			capacity: C.size_t(targets.regions[region].length),
		}
	}
	status := C.narsil_write_field_merge(w.pointer(), &native, &output)
	runtime.KeepAlive(w)
	return statusError("writeFieldMerge", status)
}
