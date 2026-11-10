package core

import "unsafe"

type StoredValueSlices struct {
	Shapes     []uint8
	Starts     []uint32
	Kinds      []uint8
	Numbers    []float64
	TextStart  []uint32
	TextLength []uint32
	Units      []uint16
	Bytes      []uint8
}

func sliceStart[T any](values []T) unsafe.Pointer {
	if len(values) == 0 {
		return nil
	}
	return unsafe.Pointer(unsafe.SliceData(values))
}

func StoredValuesOf(slices StoredValueSlices) *StoredValues {
	return &StoredValues{
		Shapes: sliceStart(slices.Shapes), ShapeCount: uintptr(len(slices.Shapes)),
		Starts: sliceStart(slices.Starts), StartCount: uintptr(len(slices.Starts)),
		Kinds: sliceStart(slices.Kinds), KindCount: uintptr(len(slices.Kinds)),
		Numbers: sliceStart(slices.Numbers), NumberCount: uintptr(len(slices.Numbers)),
		TextStart: sliceStart(slices.TextStart), TextStartCount: uintptr(len(slices.TextStart)),
		TextLength: sliceStart(slices.TextLength), TextLengthCount: uintptr(len(slices.TextLength)),
		Units: sliceStart(slices.Units), UnitCount: uintptr(len(slices.Units)),
		Bytes: sliceStart(slices.Bytes), ByteCount: uintptr(len(slices.Bytes)),
	}
}
