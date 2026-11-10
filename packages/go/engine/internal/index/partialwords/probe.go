package partialwords

import "github.com/assetcorp/narsil/packages/go/engine/internal/text"

const (
	codePointBitsInRunKey = 21
	secondShiftInRunKey   = codePointBitsInRunKey
	firstShiftInRunKey    = 2 * codePointBitsInRunKey
	utf8ContinuationMask  = 0xc0
	utf8ContinuationBits  = 0x80
)

type runKey uint64

type probe struct {
	text   string
	points []rune
}

func newProbe(written string) probe {
	wellFormed := text.ToWellFormed(written)
	return probe{text: wellFormed, points: []rune(wellFormed)}
}

func runKeyOf(first, second, third rune) runKey {
	return runKey(uint64(first)<<firstShiftInRunKey | uint64(second)<<secondShiftInRunKey | uint64(third))
}

func runKeyAt(points []rune, at int) runKey {
	return runKeyOf(points[at], points[at+1], points[at+2])
}

func utf8CodePointCount(bytes []byte) int {
	count := 0
	for _, value := range bytes {
		if value&utf8ContinuationMask != utf8ContinuationBits {
			count++
		}
	}
	return count
}
