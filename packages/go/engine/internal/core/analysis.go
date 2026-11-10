package core

/*
#include <stdlib.h>
#include "native/include/narsil_analysis.h"
*/
import "C"

import (
	"errors"
	"runtime"
	"slices"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

type AnalyseFlags uint32

const (
	AnalyseStem             AnalyseFlags = C.NARSIL_ANALYSE_STEM
	AnalyseRemoveStopWords  AnalyseFlags = C.NARSIL_ANALYSE_REMOVE_STOP_WORDS
	AnalyseRemoveDiacritics AnalyseFlags = C.NARSIL_ANALYSE_REMOVE_DIACRITICS
	AnalyseCollectSurfaces  AnalyseFlags = C.NARSIL_ANALYSE_COLLECT_SURFACES
	AnalyseSpellings        AnalyseFlags = C.NARSIL_ANALYSE_SPELLINGS
)

const MaxAnalysedUnits = C.NARSIL_MAX_ANALYSED_UNITS

var ErrTextTooLong = errors.New("the text holds more code units than the native search core analyses")

type Token struct {
	Term       string
	Position   uint32
	Surface    string
	HasSurface bool
	Original   string
}

type heldTerm struct {
	units []uint16
	term  string
}

type Analyser struct {
	resources *analyserResources
	capacity  int
	held      []heldTerm
}

type analyserResources struct {
	analyser *C.narsil_analyser
	text     *C.uint16_t
}

var analyserPool = sync.Pool{New: newAnalyser}

func newAnalyser() any {
	var created *C.narsil_analyser
	if C.narsil_analyser_create(&created) != C.NARSIL_OK {
		return nil
	}
	resources := &analyserResources{analyser: created}
	analyser := &Analyser{resources: resources}
	runtime.AddCleanup(analyser, releaseAnalyserResources, resources)
	return analyser
}

func releaseAnalyserResources(resources *analyserResources) {
	C.narsil_analyser_destroy(resources.analyser)
	C.free(unsafe.Pointer(resources.text))
}

func AcquireAnalyser() (*Analyser, error) {
	analyser, _ := analyserPool.Get().(*Analyser)
	if analyser == nil {
		return nil, &StatusError{Operation: "analyserCreate", Status: StatusOutOfMemory}
	}
	return analyser, nil
}

func (a *Analyser) Release() {
	analyserPool.Put(a)
}

func (a *Analyser) loadText(text string) (C.uint32_t, error) {
	needed := 0
	for _, r := range text {
		if r >= 0x10000 {
			needed += 2
		} else {
			needed++
		}
	}
	if needed > MaxAnalysedUnits {
		return 0, ErrTextTooLong
	}
	if needed+1 > a.capacity {
		capacity := max(needed+1, 256, a.capacity*2)
		grown := (*C.uint16_t)(C.realloc(unsafe.Pointer(a.resources.text), C.size_t(capacity*2)))
		if grown == nil {
			return 0, &StatusError{Operation: "analyse", Status: StatusOutOfMemory}
		}
		a.resources.text = grown
		a.capacity = capacity
	}
	units := unsafe.Slice((*uint16)(unsafe.Pointer(a.resources.text)), a.capacity)
	at := 0
	for _, r := range text {
		if r >= 0x10000 {
			high, low := utf16.EncodeRune(r)
			units[at] = uint16(high)
			units[at+1] = uint16(low)
			at += 2
			continue
		}
		units[at] = uint16(r)
		at++
	}
	return C.uint32_t(at), nil
}

func (a *Analyser) request(language uint32, flags AnalyseFlags, text string, stops *StopWordSet) (C.narsil_analysis_request, error) {
	length, err := a.loadText(text)
	if err != nil {
		return C.narsil_analysis_request{}, err
	}
	request := C.narsil_analysis_request{
		language: C.uint32_t(language),
		flags:    C.uint32_t(flags),
		text:     a.resources.text,
		length:   length,
	}
	if stops != nil {
		request.stop_words = stops.set
	}
	return request, nil
}

func (a *Analyser) Analyse(language uint32, flags AnalyseFlags, text string, stops *StopWordSet, visit func(Token)) error {
	request, err := a.request(language, flags, text, stops)
	if err != nil {
		return err
	}
	var tokens C.narsil_tokens
	status := C.narsil_analyse(a.resources.analyser, &request, &tokens)
	runtime.KeepAlive(stops)
	if status != C.NARSIL_OK {
		return statusError("analyse", status)
	}
	count := int(tokens.token_count)
	if count == 0 {
		return nil
	}
	records := unsafe.Slice(tokens.tokens, count)
	arena := unsafe.Slice((*uint16)(unsafe.Pointer(tokens.units)), int(tokens.unit_count))
	for index := range records {
		record := &records[index]
		token := Token{Position: uint32(record.position)}
		token.Term = a.termOf(arena, uint32(record.term_offset), uint32(record.term_length), uint32(record.term_slot))
		if uint32(record.surface_offset) != C.NARSIL_NO_SURFACE {
			token.Surface = unitsToString(arena[record.surface_offset : record.surface_offset+record.surface_length])
			token.HasSurface = true
		}
		token.Original = unitsToString(arena[record.original_offset : record.original_offset+record.original_length])
		visit(token)
	}
	return nil
}

func (a *Analyser) Transform(language uint32, flags AnalyseFlags, raw string) (string, error) {
	request, err := a.request(language, flags, raw, nil)
	if err != nil {
		return "", err
	}
	var term C.narsil_term
	status := C.narsil_transform(a.resources.analyser, &request, &term)
	if status != C.NARSIL_OK {
		return "", statusError("transform", status)
	}
	transformed := unitsToString(unsafe.Slice((*uint16)(unsafe.Pointer(term.units)), int(term.length)))
	runtime.KeepAlive(a)
	return transformed, nil
}

func (a *Analyser) termOf(arena []uint16, offset, length, slot uint32) string {
	units := arena[offset : offset+length]
	if slot >= heldTermCount {
		return unitsToString(units)
	}
	if a.held == nil {
		a.held = make([]heldTerm, heldTermCount)
	}
	held := &a.held[slot]
	if held.units != nil && slices.Equal(held.units, units) {
		return held.term
	}
	held.units = append(held.units[:0], units...)
	held.term = unitsToString(units)
	return held.term
}

func unitsToString(units []uint16) string {
	ascii := true
	for _, unit := range units {
		if unit >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		bytes := make([]byte, len(units))
		for index, unit := range units {
			bytes[index] = byte(unit)
		}
		return unsafe.String(unsafe.SliceData(bytes), len(bytes))
	}
	return string(utf16.Decode(units))
}
