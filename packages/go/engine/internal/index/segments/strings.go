package segments

import (
	"slices"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	pairStride            = 2
	runCodePoints         = core.RunCodePoints
	partialMinCodePoints  = runCodePoints + 1
	maxStringOffsetsBytes = 1<<32 - 1
)

type pairBuilder struct {
	strings core.FrozenStrings
	failed  bool
}

func newPairBuilder() *pairBuilder {
	return &pairBuilder{strings: core.FrozenStrings{Offsets: []uint32{0}}}
}

func (b *pairBuilder) add(first, second []byte, count uint32) {
	if uint64(len(b.strings.Text))+uint64(len(first))+uint64(len(second)) > maxStringOffsetsBytes {
		b.failed = true
		return
	}
	b.strings.Text = append(b.strings.Text, first...)
	b.strings.Offsets = append(b.strings.Offsets, uint32(len(b.strings.Text)))
	b.strings.Text = append(b.strings.Text, second...)
	b.strings.Offsets = append(b.strings.Offsets, uint32(len(b.strings.Text)))
	b.strings.Counts = append(b.strings.Counts, count)
}

func termUnits(table *core.TermTable, ordinal uint32) ([]uint16, bool) {
	if uint64(ordinal) >= uint64(len(table.TermOffset)) || uint64(ordinal) >= uint64(len(table.TermLength)) {
		return nil, false
	}
	start, length := uint64(table.TermOffset[ordinal]), uint64(table.TermLength[ordinal])
	if start+length > uint64(len(table.Units)) {
		return nil, false
	}
	return table.Units[start : start+length], true
}

func unitsText(units []uint16) []byte {
	encoded := make([]byte, 0, len(units))
	for _, character := range utf16.Decode(units) {
		encoded = utf8.AppendRune(encoded, character)
	}
	return encoded
}

func growingPairs(table *core.SurfaceTable, terms *core.TermTable) (*core.FrozenStrings, error) {
	if table == nil {
		return nil, nil
	}
	if len(table.Strings.Header) <= core.TermHeaderCount {
		return nil, ErrInvalidInput
	}
	count := min(uint64(table.Strings.Header[core.TermHeaderCount]), uint64(len(table.Count)), uint64(len(table.Token)))
	builder := newPairBuilder()
	for entry := range uint32(count) {
		if table.Count[entry] == 0 {
			continue
		}
		written, held := termUnits(&table.Strings, entry)
		token, known := termUnits(terms, table.Token[entry])
		if !held || !known || len(written) == 0 || len(token) == 0 {
			return nil, ErrInvalidInput
		}
		builder.add(unitsText(written), unitsText(token), table.Count[entry])
	}
	if builder.failed {
		return nil, ErrSegmentFull
	}
	return &builder.strings, nil
}

func stringAt(strings *core.FrozenStrings, at int) []byte {
	return strings.Text[strings.Offsets[at]:strings.Offsets[at+1]]
}

func residentPairs(strings *core.FrozenStrings, removed []uint32) *core.FrozenStrings {
	if strings == nil {
		return nil
	}
	kept := &core.FrozenStrings{Text: strings.Text, Offsets: strings.Offsets, Counts: make([]uint32, len(strings.Counts))}
	for at, count := range strings.Counts {
		if at < len(removed) {
			count -= min(count, removed[at])
		}
		kept.Counts[at] = count
	}
	return kept
}

type partialTable struct {
	spellings *core.FrozenStrings
	tokens    []uint32
	runs      core.FrozenSpellingRuns
}

func splitSpellings(pairs *core.FrozenStrings, terms *core.FrozenStrings) partialTable {
	table := partialTable{spellings: &core.FrozenStrings{Offsets: []uint32{0}}}
	runs := map[[runCodePoints]rune][]uint32{}
	for at := range pairs.Counts {
		spelling, token := stringAt(pairs, at*pairStride), stringAt(pairs, at*pairStride+1)
		points := []rune(string(spelling))
		ordinal, found := termOrdinal(terms, token)
		if pairs.Counts[at] == 0 || !found || len(points) < partialMinCodePoints {
			continue
		}
		entry := uint32(len(table.tokens))
		table.spellings.Text = append(table.spellings.Text, spelling...)
		table.spellings.Offsets = append(table.spellings.Offsets, uint32(len(table.spellings.Text)))
		table.spellings.Counts = append(table.spellings.Counts, pairs.Counts[at])
		table.tokens = append(table.tokens, ordinal)
		for start := 0; start+runCodePoints <= len(points); start++ {
			key := [runCodePoints]rune(points[start : start+runCodePoints])
			list := runs[key]
			if len(list) == 0 || list[len(list)-1] != entry {
				runs[key] = append(list, entry)
			}
		}
	}
	table.runs = runTable(runs)
	return table
}

func runTable(runs map[[runCodePoints]rune][]uint32) core.FrozenSpellingRuns {
	keys := make([][runCodePoints]rune, 0, len(runs))
	members := 0
	for key, list := range runs {
		keys = append(keys, key)
		members += len(list)
	}
	slices.SortFunc(keys, func(left, right [runCodePoints]rune) int {
		return slices.Compare(left[:], right[:])
	})
	table := core.FrozenSpellingRuns{
		Points:  make([]uint32, 0, len(keys)*runCodePoints),
		Offsets: make([]uint32, 1, len(keys)+1),
		Members: make([]uint32, 0, members),
	}
	for _, key := range keys {
		for _, point := range key {
			table.Points = append(table.Points, uint32(point))
		}
		table.Members = append(table.Members, runs[key]...)
		table.Offsets = append(table.Offsets, uint32(len(table.Members)))
	}
	return table
}

func spellingPairs(segment *core.FrozenSegment, removed []uint32) *core.FrozenStrings {
	spellings := segment.Spellings
	if spellings == nil {
		return nil
	}
	builder := newPairBuilder()
	for at, count := range spellings.Counts {
		if at < len(removed) {
			count -= min(count, removed[at])
		}
		token := segment.SpellingTokens[at]
		if int(token) >= len(segment.Terms.Counts) {
			continue
		}
		builder.add(stringAt(spellings, at), stringAt(&segment.Terms, int(token)), count)
	}
	return &builder.strings
}

func nonEmpty(strings core.FrozenStrings) *core.FrozenStrings {
	if len(strings.Counts) == 0 {
		return nil
	}
	return &strings
}
