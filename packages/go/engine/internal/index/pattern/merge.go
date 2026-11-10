package pattern

import "slices"

type MergeInput struct {
	Arrays Arrays
	Remap  []int32
}

func sortTailIfUnordered(values []uint32, start int) {
	for at := start + 1; at < len(values); at++ {
		if values[at-1] > values[at] {
			slices.Sort(values[start:])
			return
		}
	}
}

func inputRunCount(input *MergeInput) int {
	return min(input.Arrays.RunCount(), len(input.Arrays.Runs)/RunCodePoints)
}

func smallestRun(inputs []MergeInput, cursors []int) int {
	smallest := -1
	for input := range inputs {
		if cursors[input] >= inputRunCount(&inputs[input]) {
			continue
		}
		if smallest < 0 {
			smallest = input
			continue
		}
		order := compareRuns(inputs[input].Arrays.Runs, cursors[input]*RunCodePoints,
			inputs[smallest].Arrays.Runs, cursors[smallest]*RunCodePoints)
		if order < 0 {
			smallest = input
		}
	}
	return smallest
}

func Merge(field string, inputs []MergeInput) Arrays {
	merged := Arrays{Field: field, Documents: []uint32{}, Runs: []uint32{}, Offsets: []uint32{0}, Postings: []uint32{}}
	for at := range inputs {
		merged.Documents = appendRemappedAscending(merged.Documents, inputs[at].Arrays.Documents, inputs[at].Remap, false)
	}
	sortTailIfUnordered(merged.Documents, 0)
	cursors := make([]int, len(inputs))
	for smallest := smallestRun(inputs, cursors); smallest >= 0; smallest = smallestRun(inputs, cursors) {
		at := cursors[smallest] * RunCodePoints
		source := inputs[smallest].Arrays.Runs
		first, second, third := source[at], source[at+1], source[at+2]
		before := len(merged.Postings)
		for input := range inputs {
			arrays := &inputs[input].Arrays
			run := cursors[input]
			if run >= inputRunCount(&inputs[input]) {
				continue
			}
			runAt := run * RunCodePoints
			if arrays.Runs[runAt] != first || arrays.Runs[runAt+1] != second || arrays.Runs[runAt+2] != third {
				continue
			}
			merged.Postings = appendRemappedAscending(merged.Postings, arrays.postingsAt(run), inputs[input].Remap, false)
			cursors[input] = run + 1
		}
		if len(merged.Postings) == before {
			continue
		}
		sortTailIfUnordered(merged.Postings, before)
		merged.Runs = append(merged.Runs, first, second, third)
		merged.Offsets = append(merged.Offsets, uint32(len(merged.Postings)))
	}
	return merged
}
