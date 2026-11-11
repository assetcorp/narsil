package core

/*
#include "native/include/narsil_analysis.h"
*/
import "C"

import (
	"errors"
	"math"
	"runtime"
	"unsafe"
)

var ErrRecordUnitsFull = errors.New("the analysed text passes the largest offset a token record holds")

func (a *Analyser) AppendRecords(language uint32, flags AnalyseFlags, text string, stops *StopWordSet,
	records []TokenRecord, units []uint16) ([]TokenRecord, []uint16, error) {
	request, err := a.request(language, flags, text, stops)
	if err != nil {
		return records, units, err
	}
	var tokens C.narsil_tokens
	status := C.narsil_analyse(a.resources.analyser, &request, &tokens)
	runtime.KeepAlive(stops)
	if status != C.NARSIL_OK {
		return records, units, statusError("analyse", status)
	}
	count := int(tokens.token_count)
	if count == 0 {
		return records, units, nil
	}
	base := uint64(len(units))
	if base+uint64(tokens.unit_count) > math.MaxUint32 {
		return records, units, ErrRecordUnitsFull
	}
	analysed := unsafe.Slice((*TokenRecord)(unsafe.Pointer(tokens.tokens)), count)
	units = append(units, unsafe.Slice((*uint16)(unsafe.Pointer(tokens.units)), int(tokens.unit_count))...)
	for index := range analysed {
		record := analysed[index]
		record.TermOffset += uint32(base)
		if record.SurfaceOffset != TokenNoSurface {
			record.SurfaceOffset += uint32(base)
		}
		record.OriginalOffset, record.OriginalLength = 0, 0
		record.TermSlot = TokenNoTermSlot
		records = append(records, record)
	}
	return records, units, nil
}
