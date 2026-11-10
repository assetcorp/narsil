package core

/*
#include "native/include/narsil_field_merge.h"
#include "native/include/narsil_stored_values.h"
*/
import "C"

import "unsafe"

type NumericIndex struct {
	Values   []float64
	Ordinals []uint32
}

type BooleanIndex struct {
	TrueBits  []uint32
	FalseBits []uint32
}

type EnumIndex struct {
	Units          []uint16
	Offsets        []uint32
	PostingOffsets []uint32
	Postings       []uint32
	SuffixOrder    []uint32
}

type GeoIndex struct {
	Codes    []uint64
	Lat      []float64
	Lon      []float64
	Ordinals []uint32
}

type FieldIndex interface {
	fieldIndexRegions() fieldIndexRegions
}

type fieldIndexRegion struct {
	data   unsafe.Pointer
	length uintptr
}

type fieldIndexRegions struct {
	kind    FieldMergeKind
	count   int
	regions [FieldMergeRegionCount]fieldIndexRegion
}

func fieldRegionOf[T any](values []T) fieldIndexRegion {
	return fieldIndexRegion{data: sliceStart(values), length: uintptr(len(values))}
}

func (r fieldIndexRegion) pinnedData(held *pins) unsafe.Pointer {
	if r.data != nil {
		held.pinner.Pin(r.data)
	}
	return r.data
}

func (index *NumericIndex) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergeNumeric, count: 2}
	if index != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{fieldRegionOf(index.Values), fieldRegionOf(index.Ordinals)}
	}
	return regions
}

func (index *BooleanIndex) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergeBoolean, count: 2}
	if index != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{fieldRegionOf(index.TrueBits), fieldRegionOf(index.FalseBits)}
	}
	return regions
}

func (index *EnumIndex) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergeEnum, count: 5}
	if index != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{
			fieldRegionOf(index.Units), fieldRegionOf(index.Offsets), fieldRegionOf(index.PostingOffsets),
			fieldRegionOf(index.Postings), fieldRegionOf(index.SuffixOrder),
		}
	}
	return regions
}

func (index *GeoIndex) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergeGeo, count: 4}
	if index != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{
			fieldRegionOf(index.Codes), fieldRegionOf(index.Lat), fieldRegionOf(index.Lon), fieldRegionOf(index.Ordinals),
		}
	}
	return regions
}

func (index *PatternIndex) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergePattern, count: 4}
	if index != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{
			fieldRegionOf(index.Documents), fieldRegionOf(index.Runs), fieldRegionOf(index.Offsets),
			fieldRegionOf(index.Postings),
		}
	}
	return regions
}

func (v *StoredValues) fieldIndexRegions() fieldIndexRegions {
	regions := fieldIndexRegions{kind: FieldMergeStored, count: 8}
	if v != nil {
		regions.regions = [FieldMergeRegionCount]fieldIndexRegion{
			{v.Shapes, v.ShapeCount}, {v.Starts, v.StartCount}, {v.Kinds, v.KindCount}, {v.Numbers, v.NumberCount},
			{v.TextStart, v.TextStartCount}, {v.TextLength, v.TextLengthCount}, {v.Units, v.UnitCount},
			{v.Bytes, v.ByteCount},
		}
	}
	return regions
}

func coreFlag(set bool) C.uint32_t {
	if set {
		return 1
	}
	return 0
}

func storedValuesForCall(held *pins, values *StoredValues) C.narsil_stored_values {
	regions := values.fieldIndexRegions()
	for at := range regions.count {
		regions.regions[at].pinnedData(held)
	}
	return values.native()
}
