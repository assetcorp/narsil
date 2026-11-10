package pattern

import (
	"strconv"
	"strings"
)

func digitsValue(digits string) int64 {
	var value int64
	for at := 0; at < len(digits); at++ {
		value = value*10 + int64(digits[at]-'0')
	}
	return value
}

func allDigits(digits string, wanted byte) bool {
	for at := 0; at < len(digits); at++ {
		if digits[at] != wanted {
			return false
		}
	}
	return len(digits) > 0
}

func sameWidth(low, high string) string {
	width := len(low)
	if low == high {
		return low
	}
	if allDigits(low, '0') && allDigits(high, '9') {
		if width == 1 {
			return "[0-9]"
		}
		return "[0-9]{" + strconv.Itoa(width) + "}"
	}
	if width == 1 {
		return "[" + low + "-" + high + "]"
	}
	if low[0] == high[0] {
		return low[:1] + sameWidth(low[1:], high[1:])
	}
	parts := []string{low[:1] + sameWidth(low[1:], strings.Repeat("9", width-1))}
	lowLead := int(low[0] - '0')
	highLead := int(high[0] - '0')
	if lowLead+1 <= highLead-1 {
		parts = append(parts, "["+strconv.Itoa(lowLead+1)+"-"+strconv.Itoa(highLead-1)+"]"+strings.Repeat("[0-9]", width-1))
	}
	parts = append(parts, high[:1]+sameWidth(strings.Repeat("0", width-1), high[1:]))
	return "(" + strings.Join(parts, "|") + ")"
}

func numberRange(low, high string) string {
	if len(low) == len(high) {
		return sameWidth(low, high)
	}
	highest := digitsValue(high)
	start := digitsValue(low)
	widest := len(strconv.FormatInt(highest, 10))
	var parts []string
	power := int64(1)
	for range len(strconv.FormatInt(start, 10)) {
		power *= 10
	}
	for width := len(strconv.FormatInt(start, 10)); width <= widest; width++ {
		last := min(highest, power-1)
		parts = append(parts, sameWidth(strconv.FormatInt(start, 10), strconv.FormatInt(last, 10)))
		start = power
		power *= 10
	}
	return "(" + strings.Join(parts, "|") + ")"
}
