package pattern

import "slices"

type Arrays struct {
	Field     string
	Documents []uint32
	Runs      []uint32
	Offsets   []uint32
	Postings  []uint32
}

type Reader interface {
	Documents() []uint32
	Postings(first, second, third uint32) []uint32
}

func (arrays *Arrays) RunCount() int {
	return max(0, len(arrays.Offsets)-1)
}

func (arrays *Arrays) postingsAt(run int) []uint32 {
	if run < 0 || run+1 >= len(arrays.Offsets) {
		return nil
	}
	first, last := arrays.Offsets[run], arrays.Offsets[run+1]
	if first > last || int(last) > len(arrays.Postings) {
		return nil
	}
	return arrays.Postings[first:last:last]
}

func (arrays *Arrays) Bytes() int {
	return (len(arrays.Documents) + len(arrays.Runs) + len(arrays.Offsets) + len(arrays.Postings)) * uint32Bytes
}

func remapOrdinal(ordinal uint32, remap []int32, identity bool) (uint32, bool) {
	if identity {
		return ordinal, true
	}
	if int(ordinal) >= len(remap) || remap[ordinal] < 0 {
		return 0, false
	}
	return uint32(remap[ordinal]), true
}

func appendRemappedAscending(out, source []uint32, remap []int32, identity bool) []uint32 {
	start := len(out)
	ordered := true
	for _, ordinal := range source {
		mapped, kept := remapOrdinal(ordinal, remap, identity)
		if !kept {
			continue
		}
		if len(out) > start && out[len(out)-1] > mapped {
			ordered = false
		}
		out = append(out, mapped)
	}
	if !ordered {
		slices.Sort(out[start:])
	}
	return out
}

type runSource struct {
	count      int
	codePoints []uint32
	postingsAt func(run int) []uint32
}

func buildArrays(field string, documents []uint32, source runSource, order []int, remap []int32, identity bool) Arrays {
	built := Arrays{Field: field, Offsets: make([]uint32, 1, source.count+1)}
	built.Documents = appendRemappedAscending(make([]uint32, 0, len(documents)), documents, remap, identity)
	built.Runs = make([]uint32, 0, source.count*RunCodePoints)
	for position := range source.count {
		run := position
		if order != nil {
			run = order[position]
		}
		before := len(built.Postings)
		built.Postings = appendRemappedAscending(built.Postings, source.postingsAt(run), remap, identity)
		if len(built.Postings) == before {
			continue
		}
		at := run * RunCodePoints
		built.Runs = append(built.Runs, source.codePoints[at], source.codePoints[at+1], source.codePoints[at+2])
		built.Offsets = append(built.Offsets, uint32(len(built.Postings)))
	}
	if built.Postings == nil {
		built.Postings = []uint32{}
	}
	return built
}

func findRun(runs []uint32, first, second, third uint32) int {
	key := [RunCodePoints]uint32{first, second, third}
	low, high := 0, len(runs)/RunCodePoints
	for low < high {
		middle := int(uint(low+high) >> 1)
		difference := compareRuns(runs, middle*RunCodePoints, key[:], 0)
		if difference == 0 {
			return middle
		}
		if difference < 0 {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return -1
}

type Frozen struct {
	arrays Arrays
}

func NewFrozen(arrays Arrays) *Frozen {
	return &Frozen{arrays: arrays}
}

func (frozen *Frozen) Documents() []uint32 {
	return frozen.arrays.Documents
}

func (frozen *Frozen) Postings(first, second, third uint32) []uint32 {
	run := findRun(frozen.arrays.Runs[:min(len(frozen.arrays.Runs), frozen.arrays.RunCount()*RunCodePoints)], first, second, third)
	if run < 0 {
		return nil
	}
	return frozen.arrays.postingsAt(run)
}

func (frozen *Frozen) source() runSource {
	count := min(frozen.arrays.RunCount(), len(frozen.arrays.Runs)/RunCodePoints)
	return runSource{count: count, codePoints: frozen.arrays.Runs, postingsAt: frozen.arrays.postingsAt}
}

func (frozen *Frozen) Arrays(field string) Arrays {
	return buildArrays(field, frozen.arrays.Documents, frozen.source(), nil, nil, true)
}

func (frozen *Frozen) RemappedArrays(field string, remap []int32) Arrays {
	return buildArrays(field, frozen.arrays.Documents, frozen.source(), nil, remap, false)
}

func (frozen *Frozen) Bytes() int {
	return frozen.arrays.Bytes()
}
