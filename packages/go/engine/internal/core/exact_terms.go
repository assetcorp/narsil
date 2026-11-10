package core

/*
#include "native/include/narsil_terms.h"
*/
import "C"

func exactTermCapacity(terms uint64) uint64 {
	capacity := uint64(minExactTermSlots)
	for terms*exactTermSlotLoadDenominator >= capacity*exactTermSlotLoadNumerator && capacity < maxExactTermSlots {
		capacity *= exactTermSlotGrowthFactor
	}
	return capacity
}

func ExactTermSlots(terms *FrozenStrings) []int32 {
	count := uint64(len(terms.Counts))
	capacity := exactTermCapacity(count)
	if count == 0 || capacity <= count {
		return nil
	}
	dictionary := TermDictionary{Tokens: terms.Text, Offsets: terms.Offsets, Frequencies: terms.Counts,
		Removed: make([]uint32, count)}
	slots := make([]int32, capacity)
	var held pins
	defer held.release()
	holder := dictionary.native(&held)
	status := C.narsil_build_exact_terms(&holder.dictionary, (*C.int32_t)(pinned(&held, slots)), C.size_t(len(slots)))
	if status != C.NARSIL_OK {
		return nil
	}
	return slots
}
