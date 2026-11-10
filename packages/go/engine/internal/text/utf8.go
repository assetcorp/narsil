package text

import "unicode/utf8"

const ReplacementCharacter rune = 0xFFFD

const (
	asciiLimit        = 0x80
	continuationFirst = 0x80
	continuationLast  = 0xBF
)

type byteText interface {
	~string | ~[]byte
}

func isContinuation(value byte) bool {
	return value >= continuationFirst && value <= continuationLast
}

func sequenceBounds(lead byte) (needed int, lower byte, upper byte, initial rune) {
	switch {
	case lead >= 0xC2 && lead <= 0xDF:
		return 1, continuationFirst, continuationLast, rune(lead & 0x1F)
	case lead == 0xE0:
		return 2, 0xA0, continuationLast, rune(lead & 0x0F)
	case lead == 0xED:
		return 2, continuationFirst, 0x9F, rune(lead & 0x0F)
	case lead >= 0xE1 && lead <= 0xEF:
		return 2, continuationFirst, continuationLast, rune(lead & 0x0F)
	case lead == 0xF0:
		return 3, 0x90, continuationLast, rune(lead & 0x07)
	case lead == 0xF4:
		return 3, continuationFirst, 0x8F, rune(lead & 0x07)
	case lead >= 0xF1 && lead <= 0xF3:
		return 3, continuationFirst, continuationLast, rune(lead & 0x07)
	}
	return 0, 0, 0, 0
}

func decodeAt[T byteText](source T, at int) (codePoint rune, size int, wellFormed bool) {
	lead := source[at]
	if lead < asciiLimit {
		return rune(lead), 1, true
	}
	needed, lower, upper, codePoint := sequenceBounds(lead)
	if needed == 0 {
		return ReplacementCharacter, 1, false
	}
	consumed := 1
	for range needed {
		if at+consumed >= len(source) {
			return ReplacementCharacter, consumed, false
		}
		next := source[at+consumed]
		if next < lower || next > upper {
			return ReplacementCharacter, consumed, false
		}
		lower, upper = continuationFirst, continuationLast
		codePoint = codePoint<<6 | rune(next&0x3F)
		consumed++
	}
	return codePoint, consumed, true
}

func NextCodePoint(source string, at int) (rune, int) {
	codePoint, size, _ := decodeAt(source, at)
	return codePoint, size
}

func IsWellFormed(source string) bool {
	return utf8.ValidString(source)
}

func DecodeUTF8(source []byte) string {
	if utf8.Valid(source) {
		return string(source)
	}
	return string(appendWellFormed(make([]byte, 0, len(source)+utf8.UTFMax), source))
}

func ToWellFormed(source string) string {
	if utf8.ValidString(source) {
		return source
	}
	return string(appendWellFormed(make([]byte, 0, len(source)+utf8.UTFMax), source))
}

func appendWellFormed[T byteText](destination []byte, source T) []byte {
	for at := 0; at < len(source); {
		_, size, wellFormed := decodeAt(source, at)
		if wellFormed {
			destination = append(destination, source[at:at+size]...)
		} else {
			destination = utf8.AppendRune(destination, ReplacementCharacter)
		}
		at += size
	}
	return destination
}

func ExceedsCodePoints(source string, maximum int) bool {
	if len(source) <= maximum {
		return false
	}
	counted := 0
	for at := 0; at < len(source); {
		_, size, _ := decodeAt(source, at)
		at += size
		counted++
		if counted > maximum {
			return true
		}
	}
	return false
}

func TruncateCodePoints(source string, maximum int) string {
	if len(source) <= maximum {
		return source
	}
	at := 0
	for counted := 0; at < len(source) && counted < maximum; counted++ {
		_, size, _ := decodeAt(source, at)
		at += size
	}
	return source[:at]
}

func comparisonStart(left, right string) int {
	shorter := min(len(left), len(right))
	at := 0
	for at < shorter && left[at] == right[at] {
		at++
	}
	for back := 1; back < utf8.UTFMax && at-back >= 0; back++ {
		if !isContinuation(left[at-back]) {
			return at - back
		}
	}
	return at
}

func CompareCodePoints(left, right string) int {
	at := comparisonStart(left, right)
	leftAt, rightAt := at, at
	for leftAt < len(left) && rightAt < len(right) {
		leftCodePoint, leftSize, _ := decodeAt(left, leftAt)
		rightCodePoint, rightSize, _ := decodeAt(right, rightAt)
		if leftCodePoint != rightCodePoint {
			return compareRunes(leftCodePoint, rightCodePoint)
		}
		leftAt += leftSize
		rightAt += rightSize
	}
	return compareRemaining(len(left)-leftAt, len(right)-rightAt)
}

func compareRunes(left, right rune) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func compareRemaining(left, right int) int {
	switch {
	case left == 0 && right == 0:
		return 0
	case left == 0:
		return -1
	case right == 0:
		return 1
	}
	return 0
}
