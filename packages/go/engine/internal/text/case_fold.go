package text

import (
	"sync"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type foldScratch struct {
	units []uint16
	left  []rune
	right []rune
}

var foldScratches = sync.Pool{New: func() any { return &foldScratch{} }}

func foldUnits(destination []rune, units []uint16) []rune {
	folded, err := core.CaseFold(units, destination)
	if err != nil {
		panic(err)
	}
	return folded
}

func (scratch *foldScratch) fold(destination []rune, source string) []rune {
	scratch.units = AppendUTF16(scratch.units[:0], source)
	return foldUnits(destination, scratch.units)
}

func AppendFoldedCodePoint(destination []rune, codePoint rune) []rune {
	if codePoint < 0 || codePoint > utf8.MaxRune {
		return append(destination, codePoint)
	}
	first, second, count := utf16UnitsOf(codePoint)
	units := [2]uint16{first, second}
	return foldUnits(destination, units[:count])
}

func AppendFoldedCodePoints(destination []rune, source string) []rune {
	scratch := foldScratches.Get().(*foldScratch)
	destination = scratch.fold(destination, source)
	foldScratches.Put(scratch)
	return destination
}

func FoldedCodePointCount(source string) int {
	scratch := foldScratches.Get().(*foldScratch)
	scratch.left = scratch.fold(scratch.left[:0], source)
	counted := len(scratch.left)
	foldScratches.Put(scratch)
	return counted
}

func CompareCaseFolded(left, right string) int {
	start := comparisonStart(left, right)
	if start == len(left) && start == len(right) {
		return 0
	}
	scratch := foldScratches.Get().(*foldScratch)
	defer foldScratches.Put(scratch)
	scratch.left = scratch.fold(scratch.left[:0], left[start:])
	scratch.right = scratch.fold(scratch.right[:0], right[start:])
	shared := min(len(scratch.left), len(scratch.right))
	for at := range shared {
		if scratch.left[at] != scratch.right[at] {
			return compareRunes(scratch.left[at], scratch.right[at])
		}
	}
	return compareRemaining(len(scratch.left)-shared, len(scratch.right)-shared)
}

func CompareSortStrings(left, right string) int {
	if folded := CompareCaseFolded(left, right); folded != 0 {
		return folded
	}
	return CompareCodePoints(left, right)
}
