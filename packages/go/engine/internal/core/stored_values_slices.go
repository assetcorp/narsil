package core

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

func (s StoredValueSlices) Values() *StoredValues {
	return &StoredValues{
		Shapes: sliceStart(s.Shapes), ShapeCount: uintptr(len(s.Shapes)),
		Starts: sliceStart(s.Starts), StartCount: uintptr(len(s.Starts)),
		Kinds: sliceStart(s.Kinds), KindCount: uintptr(len(s.Kinds)),
		Numbers: sliceStart(s.Numbers), NumberCount: uintptr(len(s.Numbers)),
		TextStart: sliceStart(s.TextStart), TextStartCount: uintptr(len(s.TextStart)),
		TextLength: sliceStart(s.TextLength), TextLengthCount: uintptr(len(s.TextLength)),
		Units: sliceStart(s.Units), UnitCount: uintptr(len(s.Units)),
		Bytes: sliceStart(s.Bytes), ByteCount: uintptr(len(s.Bytes)),
	}
}
