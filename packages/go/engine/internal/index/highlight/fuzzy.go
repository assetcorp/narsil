package highlight

import "slices"

const (
	firstHighSurrogate  = 0xD800
	firstLowSurrogate   = 0xDC00
	surrogateEnd        = 0xE000
	supplementaryOffset = 0x10000
	surrogatePayload    = 10
)

func isHighSurrogate(unit uint16) bool {
	return unit >= firstHighSurrogate && unit < firstLowSurrogate
}

func isLowSurrogate(unit uint16) bool {
	return unit >= firstLowSurrogate && unit < surrogateEnd
}

func startsPair(units []uint16, at int) bool {
	return isHighSurrogate(units[at]) && at+1 < len(units) && isLowSurrogate(units[at+1])
}

func fuzzyPrefixOf(queryTerm []uint16, prefixLength int) []uint16 {
	end := 0
	for counted := 0; counted < prefixLength && end < len(queryTerm); counted++ {
		if startsPair(queryTerm, end) {
			end += 2
		} else {
			end++
		}
	}
	return queryTerm[:end]
}

func hasUnitPrefix(units, prefix []uint16) bool {
	return len(units) >= len(prefix) && slices.Equal(units[:len(prefix)], prefix)
}

func fuzzyTermMatches(queryTerm, indexTerm []uint16, tolerance, prefixLength int) bool {
	if slices.Equal(queryTerm, indexTerm) {
		return true
	}
	if tolerance <= 0 {
		return false
	}
	if !hasUnitPrefix(indexTerm, fuzzyPrefixOf(queryTerm, prefixLength)) {
		return false
	}
	return withinBandedDistance(charactersOf(queryTerm), charactersOf(indexTerm), tolerance)
}

func charactersOf(units []uint16) []rune {
	characters := make([]rune, 0, len(units))
	for at := 0; at < len(units); at++ {
		if startsPair(units, at) {
			characters = append(characters, supplementaryOffset+rune(units[at]-firstHighSurrogate)<<surrogatePayload+rune(units[at+1]-firstLowSurrogate))
			at++
			continue
		}
		characters = append(characters, rune(units[at]))
	}
	return characters
}

func withinBandedDistance(left, right []rune, tolerance int) bool {
	leftLength := len(left)
	rightLength := len(right)
	beyond := tolerance + 1
	if leftLength-rightLength > tolerance || rightLength-leftLength > tolerance {
		return false
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
			return false
		}
		previous, current = current, previous
	}
	return previous[rightLength] <= tolerance
}
