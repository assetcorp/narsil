package pattern

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type runKey [RunCodePoints]uint32

func nextCodePoint(source string, at int) (rune, int) {
	if lead := source[at]; lead < 0x80 {
		return rune(lead), 1
	}
	return text.NextCodePoint(source, at)
}

func codePointsOf(source string) []rune {
	codePoints := make([]rune, 0, len(source))
	for at := 0; at < len(source); {
		codePoint, size := nextCodePoint(source, at)
		codePoints = append(codePoints, codePoint)
		at += size
	}
	return codePoints
}

func appendTextCodePoints(destination []rune, source string, caseFold bool) []rune {
	for at := 0; at < len(source); {
		codePoint, size := nextCodePoint(source, at)
		at += size
		if caseFold {
			destination = appendFolded(destination, codePoint)
		} else {
			destination = append(destination, codePoint)
		}
	}
	return destination
}

func foldedCodePointCount(source string) int {
	return text.FoldedCodePointCount(source)
}

func runKeyAt(folded []rune, at int) runKey {
	return runKey{uint32(folded[at]), uint32(folded[at+1]), uint32(folded[at+2])}
}

func collectRunKeys(folded []rune, into map[runKey]struct{}) {
	for at := 0; at+RunCodePoints <= len(folded); at++ {
		into[runKeyAt(folded, at)] = struct{}{}
	}
}

func compareRuns(left []uint32, leftAt int, right []uint32, rightAt int) int {
	for offset := range RunCodePoints {
		leftValue, rightValue := left[leftAt+offset], right[rightAt+offset]
		if leftValue != rightValue {
			if leftValue < rightValue {
				return -1
			}
			return 1
		}
	}
	return 0
}

func compareRunKeys(left, right runKey) int {
	return compareRuns(left[:], 0, right[:], 0)
}

func forEachTextValue(value any, visit func(text string) bool) {
	switch typed := value.(type) {
	case string:
		visit(typed)
	case []any:
		for _, element := range typed {
			if textElement, isText := element.(string); isText && !visit(textElement) {
				return
			}
		}
	case []string:
		for _, element := range typed {
			if !visit(element) {
				return
			}
		}
	}
}

func holdsTextValue(value any) bool {
	switch value.(type) {
	case string, []any, []string:
		return true
	}
	return false
}
