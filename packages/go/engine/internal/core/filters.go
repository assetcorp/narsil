package core

/*
#include "native/include/narsil_filters.h"
*/
import "C"

import (
	"runtime"
	"unsafe"
)

type FilterOpcode uint32

const (
	FilterTest    FilterOpcode = C.NARSIL_FILTER_TEST
	FilterAnd     FilterOpcode = C.NARSIL_FILTER_AND
	FilterOr      FilterOpcode = C.NARSIL_FILTER_OR
	FilterNot     FilterOpcode = C.NARSIL_FILTER_NOT
	FilterAndNot  FilterOpcode = C.NARSIL_FILTER_ANDNOT
	FilterPresent FilterOpcode = C.NARSIL_FILTER_PRESENT
	FilterBitset  FilterOpcode = C.NARSIL_FILTER_BITSET
)

type FilterKind uint32

const (
	FilterKindAbsent  FilterKind = C.NARSIL_FILTER_ABSENT
	FilterKindNumeric FilterKind = C.NARSIL_FILTER_NUMERIC
	FilterKindBoolean FilterKind = C.NARSIL_FILTER_BOOLEAN
	FilterKindEnum    FilterKind = C.NARSIL_FILTER_ENUM
	FilterKindGeo     FilterKind = C.NARSIL_FILTER_GEO
)

type FilterOperator uint32

const (
	FilterEq      FilterOperator = C.NARSIL_FILTER_EQ
	FilterGt      FilterOperator = C.NARSIL_FILTER_GT
	FilterGte     FilterOperator = C.NARSIL_FILTER_GTE
	FilterLt      FilterOperator = C.NARSIL_FILTER_LT
	FilterLte     FilterOperator = C.NARSIL_FILTER_LTE
	FilterBetween FilterOperator = C.NARSIL_FILTER_BETWEEN
	FilterAny     FilterOperator = C.NARSIL_FILTER_ANY
	FilterAll     FilterOperator = C.NARSIL_FILTER_ALL
	FilterPrefix  FilterOperator = C.NARSIL_FILTER_PREFIX
	FilterSuffix  FilterOperator = C.NARSIL_FILTER_SUFFIX
	FilterRadius  FilterOperator = C.NARSIL_FILTER_RADIUS
	FilterPolygon FilterOperator = C.NARSIL_FILTER_POLYGON
)

const (
	FilterFieldRegions      = C.NARSIL_FILTER_FIELD_REGIONS
	FilterInstructionWords  = 4
	FilterStringListWords   = 2
	filterPresentRegionSlot = 0
)

type FilterField struct {
	Present []uint32
	Index   FieldIndex
}

type FilterProgram struct {
	Plan        []uint32
	Numbers     []float64
	Units       []uint16
	Offsets     []uint32
	StringLists []uint32
	Bitsets     [][]uint32
	Fields      []FilterField
	Live        []uint32
}

func FilterKindOf(index FieldIndex) (FilterKind, bool) {
	if index == nil {
		return FilterKindAbsent, true
	}
	switch index.fieldIndexRegions().kind {
	case FieldMergeNumeric:
		return FilterKindNumeric, true
	case FieldMergeBoolean:
		return FilterKindBoolean, true
	case FieldMergeEnum:
		return FilterKindEnum, true
	case FieldMergeGeo:
		return FilterKindGeo, true
	}
	return FilterKindAbsent, false
}

func (field *FilterField) native(held *pins) (C.narsil_filter_field, bool) {
	native := C.narsil_filter_field{kind: C.uint32_t(FilterKindAbsent), region_count: 1}
	native.regions[filterPresentRegionSlot] = C.narsil_filter_region{
		data:   unsafe.Pointer(pinned(held, field.Present)),
		length: C.size_t(len(field.Present)),
	}
	kind, known := FilterKindOf(field.Index)
	if !known {
		return native, false
	}
	if kind == FilterKindAbsent {
		return native, true
	}
	regions := field.Index.fieldIndexRegions()
	if regions.count+1 > FilterFieldRegions {
		return native, false
	}
	native.kind = C.uint32_t(kind)
	native.region_count = C.size_t(regions.count + 1)
	for at := range regions.count {
		native.regions[at+1] = C.narsil_filter_region{
			data:   regions.regions[at].pinnedData(held),
			length: C.size_t(regions.regions[at].length),
		}
	}
	return native, true
}

func (w *Workspace) EvaluateFilter(program *FilterProgram, into []uint32) error {
	if program == nil {
		return &StatusError{Operation: "evaluateFilter", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	fields := make([]C.narsil_filter_field, len(program.Fields))
	for at := range program.Fields {
		native, valid := program.Fields[at].native(&held)
		if !valid {
			return &StatusError{Operation: "evaluateFilter", Status: StatusInvalidArgument}
		}
		fields[at] = native
	}
	bitsets := make([]C.narsil_filter_bits, len(program.Bitsets))
	for at, words := range program.Bitsets {
		bitsets[at] = C.narsil_filter_bits{words: (*C.uint32_t)(pinned(&held, words)), count: C.size_t(len(words))}
	}
	native := C.narsil_filter_program{
		plan:         (*C.uint32_t)(pinned(&held, program.Plan)),
		plan_words:   C.size_t(len(program.Plan)),
		numbers:      (*C.double)(pinned(&held, program.Numbers)),
		number_count: C.size_t(len(program.Numbers)),
		units:        (*C.uint16_t)(pinned(&held, program.Units)),
		unit_count:   C.size_t(len(program.Units)),
		offsets:      (*C.uint32_t)(pinned(&held, program.Offsets)),
		offset_count: C.size_t(len(program.Offsets)),
		lists:        (*C.uint32_t)(pinned(&held, program.StringLists)),
		list_words:   C.size_t(len(program.StringLists)),
		bitsets:      pinned(&held, bitsets),
		bitset_count: C.size_t(len(bitsets)),
		fields:       pinned(&held, fields),
		field_count:  C.size_t(len(fields)),
		live:         C.narsil_filter_bits{words: (*C.uint32_t)(pinned(&held, program.Live)), count: C.size_t(len(program.Live))},
	}
	status := C.narsil_evaluate_filter(w.pointer(), &native, (*C.uint32_t)(pinned(&held, into)), C.size_t(len(into)))
	runtime.KeepAlive(w)
	return statusError("evaluateFilter", status)
}
