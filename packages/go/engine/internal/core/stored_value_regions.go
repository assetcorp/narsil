package core

func NewStoredValueSlices(sizes FieldMergeSizes) *StoredValueSlices {
	return &StoredValueSlices{
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

func EmptyStoredValueSlices(documents uint32) *StoredValueSlices {
	return &StoredValueSlices{Shapes: make([]uint8, documents), Starts: make([]uint32, uint64(documents)+1)}
}
