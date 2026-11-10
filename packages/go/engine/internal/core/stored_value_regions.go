package core

import "unsafe"

type StoredValueRegions struct {
	Shapes     []uint8
	Starts     []uint32
	Kinds      []uint8
	Numbers    []float64
	TextStart  []uint32
	TextLength []uint32
	Units      []uint16
	Bytes      []uint8
}

func NewStoredValueRegions(sizes FieldMergeSizes) *StoredValueRegions {
	return &StoredValueRegions{
		Shapes:     make([]uint8, sizes[0]),
		Starts:     make([]uint32, sizes[1]),
		Kinds:      make([]uint8, sizes[2]),
		Numbers:    make([]float64, sizes[3]),
		TextStart:  make([]uint32, sizes[4]),
		TextLength: make([]uint32, sizes[5]),
		Units:      make([]uint16, sizes[6]),
		Bytes:      make([]uint8, sizes[7]),
	}
}

func EmptyStoredValueRegions(documents uint32) *StoredValueRegions {
	return &StoredValueRegions{Shapes: make([]uint8, documents), Starts: make([]uint32, uint64(documents)+1)}
}

func firstElement[T any](values []T) unsafe.Pointer {
	if len(values) == 0 {
		return nil
	}
	return unsafe.Pointer(unsafe.SliceData(values))
}

func (r *StoredValueRegions) Values() *StoredValues {
	return &StoredValues{
		Shapes: firstElement(r.Shapes), ShapeCount: uintptr(len(r.Shapes)),
		Starts: firstElement(r.Starts), StartCount: uintptr(len(r.Starts)),
		Kinds: firstElement(r.Kinds), KindCount: uintptr(len(r.Kinds)),
		Numbers: firstElement(r.Numbers), NumberCount: uintptr(len(r.Numbers)),
		TextStart: firstElement(r.TextStart), TextStartCount: uintptr(len(r.TextStart)),
		TextLength: firstElement(r.TextLength), TextLengthCount: uintptr(len(r.TextLength)),
		Units: firstElement(r.Units), UnitCount: uintptr(len(r.Units)),
		Bytes: firstElement(r.Bytes), ByteCount: uintptr(len(r.Bytes)),
	}
}

func (v *StoredValues) DocumentCount() uint32 {
	if v == nil {
		return 0
	}
	return uint32(min(v.ShapeCount, uintptr(^uint32(0))))
}
