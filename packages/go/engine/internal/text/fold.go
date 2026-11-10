package text

import "unicode/utf8"

const (
	asciiUpperFirst = 'A'
	asciiUpperLast  = 'Z'
	asciiCaseOffset = 'a' - 'A'
)

func foldOf(tables *foldTables, codePoint rune) (rune, foldExpansion, bool) {
	if codePoint < asciiLimit {
		if codePoint >= asciiUpperFirst && codePoint <= asciiUpperLast {
			return codePoint + asciiCaseOffset, foldExpansion{}, false
		}
		return codePoint, foldExpansion{}, false
	}
	if folded, found := tables.single[codePoint]; found {
		return folded, foldExpansion{}, false
	}
	if expansion, found := tables.multi[codePoint]; found {
		return 0, expansion, true
	}
	return codePoint, foldExpansion{}, false
}

func AppendFoldedCodePoint(destination []rune, codePoint rune) []rune {
	folded, expansion, expands := foldOf(loadFoldTables(), codePoint)
	if !expands {
		return append(destination, folded)
	}
	return append(destination, expansion.codePoints[:expansion.count]...)
}

func AppendFoldedCodePoints(destination []rune, source string) []rune {
	tables := loadFoldTables()
	for at := 0; at < len(source); {
		codePoint, size, _ := decodeAt(source, at)
		folded, expansion, expands := foldOf(tables, codePoint)
		if expands {
			destination = append(destination, expansion.codePoints[:expansion.count]...)
		} else {
			destination = append(destination, folded)
		}
		at += size
	}
	return destination
}

func FoldedCodePointCount(source string) int {
	tables := loadFoldTables()
	counted := 0
	for at := 0; at < len(source); {
		codePoint, size, _ := decodeAt(source, at)
		_, expansion, expands := foldOf(tables, codePoint)
		if expands {
			counted += expansion.count
		} else {
			counted++
		}
		at += size
	}
	return counted
}

func FoldString(source string) string {
	tables := loadFoldTables()
	folded := make([]byte, 0, len(source))
	for at := 0; at < len(source); {
		codePoint, size, _ := decodeAt(source, at)
		single, expansion, expands := foldOf(tables, codePoint)
		if expands {
			for _, expanded := range expansion.codePoints[:expansion.count] {
				folded = utf8.AppendRune(folded, expanded)
			}
		} else {
			folded = utf8.AppendRune(folded, single)
		}
		at += size
	}
	return string(folded)
}

type foldCursor struct {
	source       string
	at           int
	pending      foldExpansion
	pendingIndex int
}

func (cursor *foldCursor) next(tables *foldTables) (rune, bool) {
	if cursor.pendingIndex < cursor.pending.count {
		codePoint := cursor.pending.codePoints[cursor.pendingIndex]
		cursor.pendingIndex++
		return codePoint, true
	}
	if cursor.at >= len(cursor.source) {
		return 0, false
	}
	codePoint, size, _ := decodeAt(cursor.source, cursor.at)
	cursor.at += size
	folded, expansion, expands := foldOf(tables, codePoint)
	if !expands {
		return folded, true
	}
	cursor.pending = expansion
	cursor.pendingIndex = 1
	return expansion.codePoints[0], true
}

func CompareCaseFolded(left, right string) int {
	start := comparisonStart(left, right)
	if start == len(left) && start == len(right) {
		return 0
	}
	tables := loadFoldTables()
	leftCursor := foldCursor{source: left, at: start}
	rightCursor := foldCursor{source: right, at: start}
	for {
		leftCodePoint, leftPresent := leftCursor.next(tables)
		rightCodePoint, rightPresent := rightCursor.next(tables)
		switch {
		case !leftPresent && !rightPresent:
			return 0
		case !leftPresent:
			return -1
		case !rightPresent:
			return 1
		case leftCodePoint != rightCodePoint:
			return compareRunes(leftCodePoint, rightCodePoint)
		}
	}
}

func CompareSortStrings(left, right string) int {
	if folded := CompareCaseFolded(left, right); folded != 0 {
		return folded
	}
	return CompareCodePoints(left, right)
}
