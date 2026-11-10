package pattern

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

type typoComparison struct {
	text      []rune
	caseFold  bool
	tolerance int
	shortest  int
	longest   int
}

func newTypoComparison(source string, prepared typoText, caseFold bool, edits int, tally *workTally) *typoComparison {
	comparison := &typoComparison{caseFold: caseFold, tolerance: edits}
	length := prepared.codePoints
	if caseFold {
		if tally != nil {
			tally.add(int64(len(prepared.folded)))
		}
		comparison.text = slices.Clone(prepared.folded)
		length = len(prepared.folded)
	} else {
		comparison.text = codePointsOf(source)
	}
	comparison.shortest = length - edits
	comparison.longest = length + edits
	return comparison
}

func (comparison *typoComparison) comparedForm(value string, scratch []rune) ([]rune, bool) {
	compared := scratch[:0]
	counted := 0
	for at := 0; at < len(value) && counted <= comparison.longest; {
		codePoint, size := nextCodePoint(value, at)
		at += size
		if comparison.caseFold {
			compared = appendFolded(compared, codePoint)
		} else {
			compared = append(compared, codePoint)
		}
		counted = len(compared)
	}
	if counted > comparison.longest || counted < comparison.shortest {
		return compared, false
	}
	return compared, true
}

func bandedDistance(left, right []rune, edits int) (bool, int) {
	rows, columns := len(left), len(right)
	beyond := uint32(edits + 1)
	if rows-columns > edits || columns-rows > edits {
		return false, 0
	}
	previous := make([]uint32, columns+1)
	current := make([]uint32, columns+1)
	for column := range previous {
		previous[column] = beyond
		current[column] = beyond
	}
	for column := 0; column <= min(columns, edits); column++ {
		previous[column] = uint32(column)
	}
	cells := 0
	for row := 1; row <= rows; row++ {
		low := max(1, row-edits)
		high := min(columns, row+edits)
		current[low-1] = beyond
		if low == 1 {
			current[low-1] = uint32(row)
		}
		rowMinimum := current[low-1]
		character := left[row-1]
		if high >= low {
			cells += high - low + 1
		}
		for column := low; column <= high; column++ {
			substitution := previous[column-1]
			if character != right[column-1] {
				substitution++
			}
			cell := min(previous[column]+1, current[column-1]+1, substitution, beyond)
			current[column] = cell
			rowMinimum = min(rowMinimum, cell)
		}
		if rowMinimum > uint32(edits) {
			return false, cells
		}
		previous, current = current, previous
	}
	return previous[columns] <= uint32(edits), cells
}

type typoTest struct {
	needed     int
	runs       []uint32
	comparison *typoComparison
}

func prepareTypoTest(source string, caseFold bool, wanted tolerance, tally *workTally) *typoTest {
	prepared := foldTypoText(source, tally)
	distinct := distinctTypoRuns(prepared, typoRunLimit(prepared.longestFold), tally)
	edits := resolvedTypoTolerance(wanted, prepared.longestFold, len(distinct)/RunCodePoints)
	if edits == 0 {
		return nil
	}
	return &typoTest{
		needed:     typoRunsNeeded(edits, prepared.longestFold),
		runs:       distinct,
		comparison: newTypoComparison(source, prepared, caseFold, edits, tally),
	}
}

func rarestLists(index Reader, test *typoTest, tally *workTally) [][]uint32 {
	if len(test.runs) < test.needed*RunCodePoints {
		return [][]uint32{index.Documents()}
	}
	lists := make([][]uint32, 0, len(test.runs)/RunCodePoints)
	for at := 0; at+RunCodePoints <= len(test.runs); at += RunCodePoints {
		tally.add(1)
		lists = append(lists, index.Postings(test.runs[at], test.runs[at+1], test.runs[at+2]))
	}
	slices.SortStableFunc(lists, func(left, right []uint32) int { return len(left) - len(right) })
	return lists[:test.needed]
}

func matchWithinTolerance(request *matchRequest, test *typoTest, tally *workTally) {
	matches := request.into
	checked := make(bitset.Bits, len(matches))
	var scratch []rune
	for _, list := range rarestLists(request.index, test, tally) {
		tally.add(int64(len(list)))
		for _, ordinal := range list {
			if tally.err != nil {
				return
			}
			if int(ordinal>>5) >= len(matches) || checked.Has(ordinal) {
				continue
			}
			checked.Set(ordinal)
			if matches.Has(ordinal) {
				continue
			}
			matched := false
			forEachTextValue(request.valueOf(ordinal), func(value string) bool {
				var compared []rune
				var comparable bool
				compared, comparable = test.comparison.comparedForm(value, scratch)
				scratch = compared
				if !comparable {
					return true
				}
				within, cells := bandedDistance(test.comparison.text, compared, test.comparison.tolerance)
				tally.add(int64(cells))
				matched = within
				return !matched && tally.err == nil
			})
			if matched {
				matches.Set(ordinal)
			}
		}
	}
}
