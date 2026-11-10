package core

/*
#include <stdlib.h>
#include "native/include/narsil_analysis.h"
*/
import "C"

import (
	"runtime"
	"unicode/utf16"
	"unsafe"
)

const heldTermCount = 16384

func LanguageCount() uint32 {
	return uint32(C.narsil_language_count())
}

func LanguageLookup(name string) (uint32, bool) {
	if name == "" {
		return 0, false
	}
	bytes := C.CBytes([]byte(name))
	defer C.free(bytes)
	var language C.uint32_t
	if C.narsil_language_lookup((*C.char)(bytes), C.size_t(len(name)), &language) != C.NARSIL_OK {
		return 0, false
	}
	return uint32(language), true
}

func LanguageName(language uint32) string {
	if language >= LanguageCount() {
		return ""
	}
	return C.GoString(C.narsil_language_name(C.uint32_t(language)))
}

func LanguageRevision(language uint32) string {
	if language >= LanguageCount() {
		return ""
	}
	return C.GoString(C.narsil_language_revision(C.uint32_t(language)))
}

func LanguageStopWords(language uint32) ([]string, error) {
	var list C.narsil_word_list
	if status := C.narsil_language_stop_words(C.uint32_t(language), &list); status != C.NARSIL_OK {
		return nil, statusError("languageStopWords", status)
	}
	count := int(list.count)
	if count == 0 {
		return nil, nil
	}
	offsets := unsafe.Slice((*uint32)(unsafe.Pointer(list.offsets)), count+1)
	units := unsafe.Slice((*uint16)(unsafe.Pointer(list.units)), int(offsets[count]))
	words := make([]string, count)
	for index := range words {
		words[index] = unitsToString(units[offsets[index]:offsets[index+1]])
	}
	return words, nil
}

type StopWordSet struct {
	set *C.narsil_stop_word_set
}

func NewStopWordSet(words []string) (*StopWordSet, error) {
	var units []uint16
	offsets := make([]uint32, 1, len(words)+1)
	for _, word := range words {
		for _, r := range word {
			units = utf16.AppendRune(units, r)
		}
		if uint64(len(units)) > uint64(^uint32(0)) {
			return nil, &StatusError{Operation: "stopWordSetCreate", Status: StatusInvalidArgument}
		}
		offsets = append(offsets, uint32(len(units)))
	}
	unitBytes := C.malloc(C.size_t(max(1, len(units)) * 2))
	offsetBytes := C.malloc(C.size_t(len(offsets) * 4))
	if unitBytes == nil || offsetBytes == nil {
		C.free(unitBytes)
		C.free(offsetBytes)
		return nil, &StatusError{Operation: "stopWordSetCreate", Status: StatusOutOfMemory}
	}
	defer C.free(unitBytes)
	defer C.free(offsetBytes)
	copy(unsafe.Slice((*uint16)(unitBytes), max(1, len(units))), units)
	copy(unsafe.Slice((*uint32)(offsetBytes), len(offsets)), offsets)
	var created *C.narsil_stop_word_set
	status := C.narsil_stop_word_set_create((*C.uint16_t)(unitBytes), (*C.uint32_t)(offsetBytes), C.uint32_t(len(words)), &created)
	if status != C.NARSIL_OK {
		return nil, statusError("stopWordSetCreate", status)
	}
	set := &StopWordSet{set: created}
	runtime.AddCleanup(set, func(pointer *C.narsil_stop_word_set) { C.narsil_stop_word_set_destroy(pointer) }, created)
	return set, nil
}
