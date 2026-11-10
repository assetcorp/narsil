package core

/*
#include "native/include/narsil_packed_tokens.h"
*/
import "C"

const PackedTokenHeaderWords = 1

func PackTokens(tokens []TokenRecord, units []uint16, records []uint32, packedUnits []uint16) (uint32, error) {
	if len(records) < PackedTokenHeaderWords {
		return 0, segmentRefusal("packTokens")
	}
	var held pins
	defer held.release()
	native, ok := nativeTokens(&held, tokens, units)
	if !ok {
		return 0, segmentRefusal("packTokens")
	}
	var unitCount C.uint32_t
	status := C.narsil_pack_tokens(&native, (*C.uint32_t)(pinned(&held, records)), C.size_t(len(records)),
		(*C.uint16_t)(pinned(&held, packedUnits)), C.size_t(len(packedUnits)), &unitCount)
	return uint32(unitCount), statusError("packTokens", status)
}
