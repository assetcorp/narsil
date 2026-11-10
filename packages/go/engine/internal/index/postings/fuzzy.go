package postings

import "strings"

func FuzzyPrefixOf(queryTerm string, prefixLength int) string {
	if prefixLength <= 0 {
		return ""
	}
	counted := 0
	for index := range queryTerm {
		if counted == prefixLength {
			return queryTerm[:index]
		}
		counted++
	}
	return queryTerm
}

func FuzzyTermMatches(queryTerm, indexTerm string, tolerance, prefixLength int) bool {
	if queryTerm == indexTerm {
		return true
	}
	if tolerance <= 0 {
		return false
	}
	if !strings.HasPrefix(indexTerm, FuzzyPrefixOf(queryTerm, prefixLength)) {
		return false
	}
	return WithinDistance(queryTerm, indexTerm, tolerance)
}

func WithinDistance(left, right string, tolerance int) bool {
	if tolerance < 0 {
		return false
	}
	if left == right {
		return true
	}
	distance, within := bandedDistance([]rune(left), []rune(right), tolerance)
	return within && distance <= tolerance
}

func bandedDistance(left, right []rune, tolerance int) (int, bool) {
	leftLength := len(left)
	rightLength := len(right)
	beyond := tolerance + 1
	if leftLength-rightLength > tolerance || rightLength-leftLength > tolerance {
		return beyond, false
	}
	previous := make([]int, rightLength+1)
	current := make([]int, rightLength+1)
	for column := range previous {
		previous[column] = beyond
		current[column] = beyond
	}
	for column := 0; column <= min(rightLength, tolerance); column++ {
		previous[column] = column
	}
	for row := 1; row <= leftLength; row++ {
		low := max(1, row-tolerance)
		high := min(rightLength, row+tolerance)
		if low == 1 {
			current[low-1] = row
		} else {
			current[low-1] = beyond
		}
		rowMinimum := current[low-1]
		character := left[row-1]
		for column := low; column <= high; column++ {
			substitution := previous[column-1]
			if character != right[column-1] {
				substitution++
			}
			cell := min(previous[column]+1, current[column-1]+1, substitution, beyond)
			current[column] = cell
			rowMinimum = min(rowMinimum, cell)
		}
		if rowMinimum > tolerance {
			return beyond, false
		}
		previous, current = current, previous
	}
	distance := previous[rightLength]
	return distance, distance <= tolerance
}
