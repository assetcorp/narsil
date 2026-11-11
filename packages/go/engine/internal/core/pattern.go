package core

/*
#include "native/include/narsil_pattern.h"
*/
import "C"

import (
	"runtime"
	"unsafe"
)

type PatternOperator uint32

const (
	PatternEq         PatternOperator = C.NARSIL_PATTERN_EQ
	PatternStartsWith PatternOperator = C.NARSIL_PATTERN_STARTS_WITH
	PatternEndsWith   PatternOperator = C.NARSIL_PATTERN_ENDS_WITH
	PatternContains   PatternOperator = C.NARSIL_PATTERN_CONTAINS
	PatternWildcard   PatternOperator = C.NARSIL_PATTERN_WILDCARD
	PatternRegex      PatternOperator = C.NARSIL_PATTERN_REGEX
)

const (
	PatternMaxTolerance  = 2
	PatternAutoTolerance = 3
	PatternMaxTextUnits  = 2048
)

type PatternIndex struct {
	Documents []uint32
	Runs      []uint32
	Offsets   []uint32
	Postings  []uint32
}

type PatternTest struct {
	Text             []uint16
	Operator         PatternOperator
	CaseFold         bool
	Tolerance        uint32
	CountPreparation bool
	MatcherBytes     uint32
}

func (i *PatternIndex) valid() bool {
	return len(i.Runs)%RunCodePoints == 0 && len(i.Offsets) == len(i.Runs)/RunCodePoints+1
}

func (t *PatternTest) valid() bool {
	return t.Operator <= PatternRegex && t.Tolerance <= PatternAutoTolerance &&
		(t.Tolerance == 0 || t.Operator == PatternEq) && len(t.Text) <= PatternMaxTextUnits
}

func pinStoredValues(held *pins, values *StoredValues) {
	for _, pointer := range []unsafe.Pointer{values.Shapes, values.Starts, values.Kinds, values.Numbers,
		values.TextStart, values.TextLength, values.Units, values.Bytes} {
		if pointer != nil {
			held.pinner.Pin(pointer)
		}
	}
}

func (w *Workspace) PatternMatch(index *PatternIndex, values *StoredValues, test *PatternTest, meter *WorkMeter, into []uint32) error {
	if index == nil || values == nil || test == nil || meter == nil || meter.words == nil || !index.valid() || !test.valid() {
		return &StatusError{Operation: "patternTest", Status: StatusInvalidArgument}
	}
	var held pins
	defer held.release()
	pinStoredValues(&held, values)
	nativeIndex := C.narsil_pattern_index{
		documents: C.narsil_pattern_list{values: (*C.uint32_t)(pinned(&held, index.Documents)), count: C.size_t(len(index.Documents))},
		runs:      C.narsil_pattern_list{values: (*C.uint32_t)(pinned(&held, index.Runs)), count: C.size_t(len(index.Runs))},
		offsets:   C.narsil_pattern_list{values: (*C.uint32_t)(pinned(&held, index.Offsets)), count: C.size_t(len(index.Offsets))},
		postings:  C.narsil_pattern_list{values: (*C.uint32_t)(pinned(&held, index.Postings)), count: C.size_t(len(index.Postings))},
	}
	nativeTest := C.narsil_pattern_test{
		text:          (*C.uint16_t)(pinned(&held, test.Text)),
		length:        C.size_t(len(test.Text)),
		operator_kind: C.uint32_t(test.Operator),
		tolerance:     C.uint32_t(test.Tolerance),
		matcher_bytes: C.uint32_t(test.MatcherBytes),
	}
	if test.CaseFold {
		nativeTest.case_fold = 1
	}
	if test.CountPreparation {
		nativeTest.count_preparation = 1
	}
	nativeValues := values.native()
	nativeMeter := meter.native()
	status := C.narsil_pattern_match(w.pointer(), &nativeIndex, &nativeValues, &nativeTest, &nativeMeter,
		(*C.uint32_t)(pinned(&held, into)), C.size_t(len(into)))
	runtime.KeepAlive(w)
	runtime.KeepAlive(meter)
	return statusError("patternTest", status)
}
