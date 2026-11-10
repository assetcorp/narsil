package core

/*
#include "native/include/narsil_pattern.h"
*/
import "C"

import "unsafe"

const (
	MaxFoldCodePoints   = 3
	maxCaseFoldUnits    = 1 << 20
	highSurrogateFirst  = 0xD800
	highSurrogateBeyond = 0xDC00
)

func foldChunk(units []uint16, folded []rune) ([]rune, error) {
	start := len(folded)
	needed := start + len(units)*MaxFoldCodePoints
	if cap(folded) < needed {
		grown := make([]rune, start, needed)
		copy(grown, folded)
		folded = grown
	}
	room := folded[start:needed]
	var held pins
	defer held.release()
	var count C.uint32_t
	status := C.narsil_case_fold((*C.uint16_t)(pinned(&held, units)), C.size_t(len(units)),
		(*C.uint32_t)(unsafe.Pointer(pinned(&held, room))), C.size_t(len(room)), &count)
	if err := statusError("caseFold", status); err != nil {
		return folded, err
	}
	return folded[:start+int(count)], nil
}

func CaseFold(units []uint16, folded []rune) ([]rune, error) {
	for len(units) > 0 {
		length := min(len(units), maxCaseFoldUnits)
		if last := units[length-1]; length < len(units) && last >= highSurrogateFirst && last < highSurrogateBeyond {
			length--
		}
		var err error
		if folded, err = foldChunk(units[:length], folded); err != nil {
			return folded, err
		}
		units = units[length:]
	}
	return folded, nil
}
