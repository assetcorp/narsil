package keyword

import (
	"bytes"
	"math"
	"unicode/utf8"
)

const (
	continuationMask = 0xC0
	continuationByte = 0x80
)

func (checker *Checker) Offsets(offsets Uint32s, listSize int, name string) {
	if checker.err != nil {
		return
	}
	count := offsets.Len()
	if count == 0 {
		checker.Fail(name+" must hold at least one value", map[string]any{"field": name})
		return
	}
	if offsets.At(0) != 0 {
		checker.Fail(name+" must start at 0", map[string]any{"field": name})
		return
	}
	for at := 1; at < count; at++ {
		if offsets.At(at) < offsets.At(at-1) {
			checker.Fail(name+" decreases at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
	if int64(offsets.Last()) != int64(listSize) {
		checker.Fail(name+" ends at "+itoa(int(offsets.Last()))+" where the list it divides holds "+itoa(listSize),
			map[string]any{"field": name})
	}
}

func (checker *Checker) UTF8Entries(blob []byte, offsets Uint32s, name string) {
	if checker.err != nil {
		return
	}
	if !utf8.Valid(blob) {
		checker.Fail(name+" is not valid UTF-8", map[string]any{"field": name})
		return
	}
	for at := range offsets.Len() {
		offset := int(offsets.At(at))
		if offset < len(blob) && blob[offset]&continuationMask == continuationByte {
			checker.Fail(name+" splits a character at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) Ordinals(values Uint32s, documentCount uint32, name string) {
	checker.Below(values, documentCount, name)
}

func (checker *Checker) Below(values Uint32s, limit uint32, name string) {
	if checker.err != nil {
		return
	}
	for at := range values.Len() {
		if values.At(at) >= limit {
			checker.Fail(name+" holds "+itoa(int(values.At(at)))+" at entry "+itoa(at)+", at or above "+
				itoa(int(limit)), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) StrictlyAscending(values Uint32s, start int, end int, name string) {
	if checker.err != nil {
		return
	}
	for at := start + 1; at < end; at++ {
		if values.At(at) <= values.At(at-1) {
			checker.Fail(name+" fails to ascend strictly at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) EntriesAscend(blob []byte, offsets Uint32s, order Uint32s, name string) {
	if checker.err != nil {
		return
	}
	count := offsets.Len() - 1
	for at := 1; at < count; at++ {
		left, right := at-1, at
		if order != nil {
			left, right = int(order.At(at-1)), int(order.At(at))
		}
		if bytes.Compare(entryOf(blob, offsets, left), entryOf(blob, offsets, right)) >= 0 {
			checker.Fail(name+" fails to ascend strictly at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) SpellingEntriesAscend(blob []byte, offsets Uint32s, tokens Uint32s, name string) {
	if checker.err != nil {
		return
	}
	for at := 1; at < tokens.Len(); at++ {
		order := bytes.Compare(entryOf(blob, offsets, at-1), entryOf(blob, offsets, at))
		if order == 0 && tokens.At(at-1) < tokens.At(at) {
			order = -1
		}
		if order >= 0 {
			checker.Fail(name+" fails to ascend strictly at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) NonZero(values Uint32s, name string) {
	if checker.err != nil {
		return
	}
	for at := range values.Len() {
		if values.At(at) == 0 {
			checker.Fail(name+" holds 0 at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) Permutation(order Uint32s, name string) {
	if checker.err != nil {
		return
	}
	count := order.Len()
	seen := make([]bool, count)
	for at := range count {
		ordinal := order.At(at)
		if int64(ordinal) >= int64(count) || seen[ordinal] {
			checker.Fail(name+" repeats or overruns ordinal "+itoa(int(ordinal)), map[string]any{"field": name, "at": at})
			return
		}
		seen[ordinal] = true
	}
}

func (checker *Checker) ValuesAscendWithoutNaN(values Float64s, name string) {
	if checker.err != nil {
		return
	}
	for at := range values.Len() {
		value := values.At(at)
		if math.IsNaN(value) {
			checker.Fail(name+" holds NaN at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
		if at > 0 && value < values.At(at-1) {
			checker.Fail(name+" descends at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) Within(values Float64s, lowest float64, highest float64, name string) {
	if checker.err != nil {
		return
	}
	for at := range values.Len() {
		value := values.At(at)
		if !(value >= lowest && value <= highest) {
			checker.Fail(name+" holds a value outside its range at entry "+itoa(at), map[string]any{"field": name, "at": at})
			return
		}
	}
}

func (checker *Checker) RunsAscend(runs Uint32s, name string) {
	if checker.err != nil {
		return
	}
	for run := 1; run*CodePointsInRun < runs.Len(); run++ {
		at := run * CodePointsInRun
		before := at - CodePointsInRun
		order := 0
		for part := range CodePointsInRun {
			if order != 0 {
				break
			}
			current, previous := runs.At(at+part), runs.At(before+part)
			if current > previous {
				order = 1
			} else if current < previous {
				order = -1
			}
		}
		if order <= 0 {
			checker.Fail(name+" fails to ascend strictly at run "+itoa(run), map[string]any{"field": name, "run": run})
			return
		}
	}
}
