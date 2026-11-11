package core

/*
#include "native/include/narsil_segments.h"
*/
import "C"

import (
	"math"
	"unsafe"
)

const (
	TokenNoSurface   = C.NARSIL_NO_SURFACE
	TokenNoTermSlot  = C.NARSIL_NO_TERM_SLOT
	MaxSegmentFields = 1 << 16
)

type TokenRecord struct {
	Position       uint32
	TermOffset     uint32
	TermLength     uint32
	SurfaceOffset  uint32
	SurfaceLength  uint32
	OriginalOffset uint32
	OriginalLength uint32
	TermSlot       uint32
}

const (
	_ = unsafe.Sizeof(TokenRecord{}) - unsafe.Sizeof(C.narsil_token{})
	_ = unsafe.Sizeof(C.narsil_token{}) - unsafe.Sizeof(TokenRecord{})
	_ = unsafe.Alignof(C.narsil_token{}) - unsafe.Alignof(TokenRecord{})
)

const TokenRecordWords = int(unsafe.Sizeof(TokenRecord{}) / unsafe.Sizeof(uint32(0)))

type FieldTokens struct {
	Field  uint16
	Tokens []TokenRecord
	Units  []uint16
}

func nativeTokens(held *pins, tokens []TokenRecord, units []uint16) (C.narsil_tokens, bool) {
	if uint64(len(tokens)) > math.MaxUint32 || uint64(len(units)) > math.MaxUint32 {
		return C.narsil_tokens{}, false
	}
	return C.narsil_tokens{
		tokens:      (*C.narsil_token)(unsafe.Pointer(pinned(held, tokens))),
		token_count: C.uint32_t(len(tokens)),
		units:       (*C.uint16_t)(pinned(held, units)),
		unit_count:  C.uint32_t(len(units)),
	}, true
}

func nativeFieldTokens(held *pins, fields []FieldTokens) (*C.narsil_field_tokens, bool) {
	if len(fields) > MaxSegmentFields {
		return nil, false
	}
	if len(fields) == 0 {
		return nil, true
	}
	natives := make([]C.narsil_field_tokens, len(fields))
	for index := range fields {
		field := &fields[index]
		tokens, ok := nativeTokens(held, field.Tokens, field.Units)
		if !ok {
			return nil, false
		}
		natives[index] = C.narsil_field_tokens{field: C.uint16_t(field.Field), tokens: tokens}
	}
	return pinned(held, natives), true
}

func segmentRefusal(operation string) error {
	return &StatusError{Operation: operation, Status: StatusInvalidArgument}
}

func bitsetWords(capacity uint64) uint64 {
	if capacity == 0 {
		return 1
	}
	return (capacity-1)/32 + 1
}
