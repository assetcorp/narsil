package core

/*
#include "native/include/narsil_stored_values.h"
*/
import "C"

import "unsafe"

type StoredValues struct {
	Shapes          unsafe.Pointer
	ShapeCount      uintptr
	Starts          unsafe.Pointer
	StartCount      uintptr
	Kinds           unsafe.Pointer
	KindCount       uintptr
	Numbers         unsafe.Pointer
	NumberCount     uintptr
	TextStart       unsafe.Pointer
	TextStartCount  uintptr
	TextLength      unsafe.Pointer
	TextLengthCount uintptr
	Units           unsafe.Pointer
	UnitCount       uintptr
	Bytes           unsafe.Pointer
	ByteCount       uintptr
}

func (v *StoredValues) native() C.narsil_stored_values {
	return C.narsil_stored_values{
		shapes:            (*C.uint8_t)(v.Shapes),
		shape_count:       C.size_t(v.ShapeCount),
		starts:            (*C.uint32_t)(v.Starts),
		start_count:       C.size_t(v.StartCount),
		kinds:             (*C.uint8_t)(v.Kinds),
		kind_count:        C.size_t(v.KindCount),
		numbers:           (*C.double)(v.Numbers),
		number_count:      C.size_t(v.NumberCount),
		text_start:        (*C.uint32_t)(v.TextStart),
		text_start_count:  C.size_t(v.TextStartCount),
		text_length:       (*C.uint32_t)(v.TextLength),
		text_length_count: C.size_t(v.TextLengthCount),
		units:             (*C.uint16_t)(v.Units),
		unit_count:        C.size_t(v.UnitCount),
		bytes:             (*C.uint8_t)(v.Bytes),
		byte_count:        C.size_t(v.ByteCount),
	}
}
