package text

import "unicode/utf8"

const (
	supplementaryFirst rune   = 0x10000
	highSurrogateFirst uint16 = 0xD800
	lowSurrogateFirst  uint16 = 0xDC00
	surrogateEnd       uint16 = 0xE000
	surrogatePayload          = 0x3FF
	surrogateShift            = 10
)

func utf16UnitsOf(codePoint rune) (first uint16, second uint16, count int) {
	if codePoint < supplementaryFirst {
		return uint16(codePoint), 0, 1
	}
	offset := codePoint - supplementaryFirst
	return highSurrogateFirst + uint16(offset>>surrogateShift), lowSurrogateFirst + uint16(offset&surrogatePayload), 2
}

func AppendUTF16(destination []uint16, source string) []uint16 {
	for at := 0; at < len(source); {
		codePoint, size, _ := decodeAt(source, at)
		first, second, count := utf16UnitsOf(codePoint)
		destination = append(destination, first)
		if count == 2 {
			destination = append(destination, second)
		}
		at += size
	}
	return destination
}

func EncodeUTF16(source string) []uint16 {
	return AppendUTF16(make([]uint16, 0, len(source)), source)
}

func UTF16Length(source string) int {
	length := 0
	for at := 0; at < len(source); {
		if source[at] < asciiLimit {
			at++
			length++
			continue
		}
		codePoint, size, _ := decodeAt(source, at)
		_, _, count := utf16UnitsOf(codePoint)
		length += count
		at += size
	}
	return length
}

func isHighSurrogate(unit uint16) bool {
	return unit >= highSurrogateFirst && unit < lowSurrogateFirst
}

func isLowSurrogate(unit uint16) bool {
	return unit >= lowSurrogateFirst && unit < surrogateEnd
}

func AppendUTF16AsUTF8(destination []byte, units []uint16) []byte {
	for at := 0; at < len(units); at++ {
		unit := units[at]
		switch {
		case isHighSurrogate(unit) && at+1 < len(units) && isLowSurrogate(units[at+1]):
			codePoint := supplementaryFirst + rune(unit-highSurrogateFirst)<<surrogateShift + rune(units[at+1]-lowSurrogateFirst)
			destination = utf8.AppendRune(destination, codePoint)
			at++
		case isHighSurrogate(unit) || isLowSurrogate(unit):
			destination = utf8.AppendRune(destination, ReplacementCharacter)
		default:
			destination = utf8.AppendRune(destination, rune(unit))
		}
	}
	return destination
}

func DecodeUTF16(units []uint16) string {
	return string(AppendUTF16AsUTF8(make([]byte, 0, len(units)), units))
}

func CompareUTF16Units(left, right string) int {
	at := comparisonStart(left, right)
	leftAt, rightAt := at, at
	for leftAt < len(left) && rightAt < len(right) {
		leftCodePoint, leftSize, _ := decodeAt(left, leftAt)
		rightCodePoint, rightSize, _ := decodeAt(right, rightAt)
		if leftCodePoint != rightCodePoint {
			leftFirst, leftSecond, _ := utf16UnitsOf(leftCodePoint)
			rightFirst, rightSecond, _ := utf16UnitsOf(rightCodePoint)
			if leftFirst != rightFirst {
				return compareUnits(leftFirst, rightFirst)
			}
			return compareUnits(leftSecond, rightSecond)
		}
		leftAt += leftSize
		rightAt += rightSize
	}
	return compareRemaining(len(left)-leftAt, len(right)-rightAt)
}

func compareUnits(left, right uint16) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}
