package fieldindex

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

type NumberCount struct {
	Value float64
	Count int
}

func (index *Numeric) EqualInto(value float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, lowerBound(values, value), upperBound(values, value), into)
}

func (index *Numeric) AboveInto(value float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, upperBound(values, value), len(values), into)
}

func (index *Numeric) AtLeastInto(value float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, lowerBound(values, value), len(values), into)
}

func (index *Numeric) BelowInto(value float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, 0, lowerBound(values, value), into)
}

func (index *Numeric) AtMostInto(value float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, 0, upperBound(values, value), into)
}

func (index *Numeric) BetweenInto(low, high float64, into bitset.Bits) {
	values, ordinals := index.columns()
	setSpan(ordinals, lowerBound(values, low), upperBound(values, high), into)
}

func (index *Numeric) AllInto(into bitset.Bits) {
	_, ordinals := index.columns()
	setSpan(ordinals, 0, len(ordinals), into)
}

func (index *Numeric) ValueCounts(matched bitset.Bits) []NumberCount {
	values, ordinals := index.columns()
	var counts []NumberCount
	var scratch []uint32
	for start := 0; start < len(values); {
		value := values[start]
		end := start + 1
		for end < len(values) && values[end] == value {
			end++
		}
		count := 0
		if end-start == 1 {
			if matched.Has(ordinals[start]) {
				count = 1
			}
		} else {
			scratch = matchedOrdinals(scratch[:0], ordinals[start:end], matched)
			count = distinctCount(scratch)
		}
		if count > 0 {
			counts = append(counts, NumberCount{Value: withoutNegativeZero(value), Count: count})
		}
		start = end
	}
	return counts
}

func (index *Numeric) RangeCount(from, to float64, matched bitset.Bits) int {
	values, ordinals := index.columns()
	start := lowerBound(values, from)
	end := lowerBound(values, to)
	if start >= end {
		return 0
	}
	return distinctCount(matchedOrdinals(nil, ordinals[start:end], matched))
}

func setSpan(ordinals []uint32, from, to int, into bitset.Bits) {
	for at := from; at < to; at++ {
		into.Set(ordinals[at])
	}
}

func matchedOrdinals(destination []uint32, ordinals []uint32, matched bitset.Bits) []uint32 {
	for _, ordinal := range ordinals {
		if matched.Has(ordinal) {
			destination = append(destination, ordinal)
		}
	}
	return destination
}

func distinctCount(ordinals []uint32) int {
	if len(ordinals) < 2 {
		return len(ordinals)
	}
	slices.Sort(ordinals)
	count := 1
	for at := 1; at < len(ordinals); at++ {
		if ordinals[at] != ordinals[at-1] {
			count++
		}
	}
	return count
}

func withoutNegativeZero(value float64) float64 {
	if value == 0 {
		return 0
	}
	return value
}
