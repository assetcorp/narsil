package partialwords

import (
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const uint32Bytes = 4

type FrozenTable struct {
	Fields     []string
	Text       []byte
	Offsets    []uint32
	Tokens     []uint32
	Counts     []uint32
	Runs       []uint32
	RunOffsets []uint32
	RunEntries []uint32
	uncounted  []bool
}

type Uint32Column interface {
	Len() int
	At(index int) uint32
}

type orderedSpelling struct {
	spelling   string
	tokenIndex int
	count      int
}

func compareOrderedSpellings(left, right *orderedSpelling) int {
	if order := text.CompareCodePoints(left.spelling, right.spelling); order != 0 {
		return order
	}
	return left.tokenIndex - right.tokenIndex
}

func orderedSpellingsOf(source EncodedSpellings, find func(token string) int) []orderedSpelling {
	entries := min(len(source.Tokens), len(source.Spellings), len(source.Counts))
	ordered := make([]orderedSpelling, 0, entries)
	for at := range entries {
		if source.Counts[at] <= 0 {
			continue
		}
		tokenIndex := find(source.Tokens[at])
		if tokenIndex >= 0 {
			ordered = append(ordered, orderedSpelling{spelling: text.ToWellFormed(source.Spellings[at]), tokenIndex: tokenIndex, count: source.Counts[at]})
		}
	}
	sort.Slice(ordered, func(left, right int) bool { return compareOrderedSpellings(&ordered[left], &ordered[right]) < 0 })
	distinct := ordered[:0]
	for _, entry := range ordered {
		if last := len(distinct) - 1; last >= 0 && compareOrderedSpellings(&distinct[last], &entry) == 0 {
			distinct[last].count += entry.count
			continue
		}
		distinct = append(distinct, entry)
	}
	return distinct
}

func BuildFrozenTable(source EncodedSpellings, find func(token string) int) *FrozenTable {
	table := &FrozenTable{Fields: append([]string(nil), source.Fields...), Offsets: []uint32{0}}
	runLists := map[runKey][]uint32{}
	for _, entry := range orderedSpellingsOf(source, find) {
		points := []rune(entry.spelling)
		if len(points) <= runCodePoints {
			continue
		}
		index := uint32(len(table.Tokens))
		table.Text = append(table.Text, entry.spelling...)
		table.Offsets = append(table.Offsets, uint32(len(table.Text)))
		table.Tokens = append(table.Tokens, uint32(entry.tokenIndex))
		table.Counts = append(table.Counts, uint32(entry.count))
		for at := 0; at+runCodePoints <= len(points); at++ {
			key := runKeyAt(points, at)
			list := runLists[key]
			if len(list) == 0 || list[len(list)-1] != index {
				runLists[key] = append(list, index)
			}
		}
	}
	keys := make([]runKey, 0, len(runLists))
	members := 0
	for key, list := range runLists {
		keys = append(keys, key)
		members += len(list)
	}
	sort.Slice(keys, func(left, right int) bool { return keys[left] < keys[right] })
	table.Runs = make([]uint32, 0, len(keys)*runCodePoints)
	table.RunOffsets = make([]uint32, 1, len(keys)+1)
	table.RunEntries = make([]uint32, 0, members)
	for _, key := range keys {
		table.Runs = append(table.Runs, runPointsOf(key)...)
		table.RunEntries = append(table.RunEntries, runLists[key]...)
		table.RunOffsets = append(table.RunOffsets, uint32(len(table.RunEntries)))
	}
	return table
}

func runPointsOf(key runKey) []uint32 {
	const codePointMask = 1<<codePointBitsInRunKey - 1
	return []uint32{
		uint32(key >> firstShiftInRunKey & codePointMask),
		uint32(key >> secondShiftInRunKey & codePointMask),
		uint32(key & codePointMask),
	}
}

func copiedColumn(column Uint32Column) []uint32 {
	if column == nil {
		return nil
	}
	values := make([]uint32, column.Len())
	for at := range values {
		values[at] = column.At(at)
	}
	return values
}

func invalidColumn(reason string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid partialWords column: "+reason, map[string]any{"column": "partialWords"})
}

func NewFrozenTable(fields []string, spellings []byte, offsets, tokens, counts, runs, runOffsets, runEntries Uint32Column, tokenCount int) (*FrozenTable, error) {
	table := &FrozenTable{
		Fields: append([]string(nil), fields...), Text: spellings,
		Offsets: copiedColumn(offsets), Tokens: copiedColumn(tokens), Counts: copiedColumn(counts),
		Runs: copiedColumn(runs), RunOffsets: copiedColumn(runOffsets), RunEntries: copiedColumn(runEntries),
	}
	if err := table.check(tokenCount); err != nil {
		return nil, err
	}
	return table, nil
}

func ascendingWithin(values []uint32, limit int) bool {
	previous := uint32(0)
	for _, value := range values {
		if value < previous || int64(value) > int64(limit) {
			return false
		}
		previous = value
	}
	return true
}

func (t *FrozenTable) check(tokenCount int) error {
	entries := len(t.Tokens)
	switch {
	case len(t.Offsets) != entries+1 || len(t.Counts) != entries:
		return invalidColumn("offsets must hold one value more than tokens, and counts one value per token")
	case !ascendingWithin(t.Offsets, len(t.Text)):
		return invalidColumn("offsets must ascend within the spelling text")
	case len(t.Runs)%runCodePoints != 0 || len(t.RunOffsets) != len(t.Runs)/runCodePoints+1:
		return invalidColumn("runOffsets must hold one value more than the runs")
	case !ascendingWithin(t.RunOffsets, len(t.RunEntries)):
		return invalidColumn("runOffsets must ascend within runEntries")
	}
	for _, token := range t.Tokens {
		if int64(token) >= int64(tokenCount) {
			return invalidColumn("token " + strconv.FormatUint(uint64(token), 10) + " lies beyond the token table")
		}
	}
	for _, entry := range t.RunEntries {
		if int64(entry) >= int64(entries) {
			return invalidColumn("run entry " + strconv.FormatUint(uint64(entry), 10) + " lies beyond the spellings")
		}
	}
	return nil
}

func (t *FrozenTable) EntryCount() int {
	return len(t.Tokens)
}

func (t *FrozenTable) Spelling(entry int) string {
	return string(t.Text[t.Offsets[entry]:t.Offsets[entry+1]])
}

func (t *FrozenTable) CoversEveryDocument(fields []string) bool {
	return t != nil && t.uncounted == nil && SameFields(t.Fields, fields)
}

func (t *FrozenTable) counted(ordinal int) bool {
	return t.uncounted == nil || ordinal >= len(t.uncounted) || !t.uncounted[ordinal]
}

func (t *FrozenTable) Bytes() int {
	return len(t.Text) + uint32Bytes*(len(t.Offsets)+len(t.Tokens)+len(t.Counts)+len(t.Runs)+len(t.RunOffsets)+len(t.RunEntries))
}

func (t *FrozenTable) CountSpellings(counts *SpellingCounts, tokenAt func(index int) string) {
	for entry := range t.Tokens {
		counts.Count(tokenAt(int(t.Tokens[entry])), t.Spelling(entry), int(t.Counts[entry]))
	}
}

func (t *FrozenTable) findRun(first, second, third uint32) int {
	low, high := 0, len(t.Runs)/runCodePoints
	for low < high {
		middle := int(uint(low+high) >> 1)
		at := middle * runCodePoints
		difference := compareRunPoint(t.Runs[at], first)
		if difference == 0 {
			difference = compareRunPoint(t.Runs[at+1], second)
		}
		if difference == 0 {
			difference = compareRunPoint(t.Runs[at+2], third)
		}
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

func compareRunPoint(stored, wanted uint32) int {
	switch {
	case stored < wanted:
		return -1
	case stored > wanted:
		return 1
	}
	return 0
}

func (t *FrozenTable) narrowestRun(points []rune) int {
	narrowest, narrowestLength := -1, uint32(0)
	for at := 0; at+runCodePoints <= len(points); at++ {
		run := t.findRun(uint32(points[at]), uint32(points[at+1]), uint32(points[at+2]))
		if run < 0 {
			return -1
		}
		length := t.RunOffsets[run+1] - t.RunOffsets[run]
		if narrowest < 0 || length < narrowestLength {
			narrowest, narrowestLength = run, length
		}
	}
	return narrowest
}
