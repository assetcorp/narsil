package pattern

import "slices"

func classRanges(class className) []uint32 {
	switch class {
	case classDigit:
		return []uint32{0x30, 0x39}
	case classWord:
		return []uint32{0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a}
	}
	return []uint32{0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x20}
}

type rangePair struct {
	low  uint32
	high uint32
}

func mergedRanges(bounds []uint32) []uint32 {
	pairs := make([]rangePair, 0, len(bounds)/2)
	for at := 0; at+1 < len(bounds); at += 2 {
		pairs = append(pairs, rangePair{bounds[at], bounds[at+1]})
	}
	slices.SortStableFunc(pairs, func(left, right rangePair) int {
		switch {
		case left.low < right.low:
			return -1
		case left.low > right.low:
			return 1
		}
		return 0
	})
	merged := make([]uint32, 0, len(bounds))
	for _, pair := range pairs {
		last := len(merged) - 1
		if len(merged) > 0 && uint64(pair.low) <= uint64(merged[last])+1 {
			merged[last] = max(merged[last], pair.high)
		} else {
			merged = append(merged, pair.low, pair.high)
		}
	}
	return merged
}

func codePointBound(codePoint rune) uint32 {
	return uint32(max(codePoint, 0))
}

func rangeBoundsOf(items []setItem) []uint32 {
	bounds := make([]uint32, 0, len(items)*2)
	for _, item := range items {
		switch item.kind {
		case setMember:
			bounds = append(bounds, codePointBound(item.codePoint), codePointBound(item.codePoint))
		case setRange:
			bounds = append(bounds, codePointBound(item.low), codePointBound(item.high))
		default:
			bounds = append(bounds, classRanges(item.class)...)
		}
	}
	return bounds
}

func newRangeTest(ranges []uint32, negated, folded bool) *codePointTest {
	return &codePointTest{bytes: len(ranges)*uint32Bytes + codePointTestEntryBytes, ranges: ranges, negated: negated, folded: folded}
}

func classTest(class className) *codePointTest {
	return newRangeTest(mergedRanges(classRanges(class)), false, false)
}

func setTest(items []setItem, negated, caseFold bool) *codePointTest {
	return newRangeTest(mergedRanges(rangeBoundsOf(items)), negated, caseFold)
}
