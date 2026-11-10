package growing

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func codePoints(text []uint16, visit func(uint32)) {
	for at := 0; at < len(text); at++ {
		unit := uint32(text[at])
		if unit >= 0xd800 && unit < 0xdc00 && at+1 < len(text) {
			low := uint32(text[at+1])
			if low >= 0xdc00 && low < 0xe000 {
				visit(0x10000 + (unit-0xd800)<<10 + (low - 0xdc00))
				at++
				continue
			}
		}
		visit(unit)
	}
}

func pointCount(text []uint16) uint32 {
	var count uint32
	codePoints(text, func(uint32) { count++ })
	return count
}

func distinctRuns(text []uint16, seen map[[runPoints]uint32]struct{}) uint64 {
	clear(seen)
	var run [runPoints]uint32
	points := 0
	codePoints(text, func(point uint32) {
		copy(run[:], run[1:])
		run[runPoints-1] = point
		points++
		if points >= runPoints {
			seen[run] = struct{}{}
		}
	})
	return uint64(len(seen))
}

func spellingRefusal(reason string) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, reason, nil)
}

func (t *spellingTable) reserveWords(workspace *core.Workspace, words [][]uint16) (uint64, error) {
	spellings := make([][]uint16, 0, len(words))
	for _, word := range words {
		if pointCount(word) > spellingMinPoints {
			spellings = append(spellings, word)
		}
	}
	ordinals, err := storedOrdinals(workspace, t.dictionary(), spellings)
	if err != nil {
		return 0, err
	}
	count := t.strings.count()
	held := t.strings.unitsUsed()
	units := held
	added := uint64(0)
	members := uint64(0)
	seen := map[[runPoints]uint32]struct{}{}
	for at, word := range spellings {
		if ordinals[at] != core.TermAbsent {
			continue
		}
		if count+added >= maxStringOrdinal || uint64(len(word)) > maxStringUnits-(units-held) {
			return 0, spellingRefusal("the spelling table has no room for another spelling")
		}
		added++
		units += uint64(len(word))
		members += distinctRuns(word, seen)
	}
	if err := t.reserve(count+added, units, &t.codePoints); err != nil {
		return 0, err
	}
	if members == 0 {
		return 0, nil
	}
	return members, t.runs.reserve(uint64(t.runs.header[headerCount]) + members)
}
