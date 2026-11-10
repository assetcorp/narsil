package facets

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const plainObjectText = "[object Object]"

var (
	weekdayNames = [...]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	monthNames   = [...]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
)

const universalTimeZoneText = " GMT+0000 (Coordinated Universal Time)"

func javaScriptString(value any) string {
	return string(appendJavaScriptString(nil, value))
}

func appendJavaScriptString(destination []byte, value any) []byte {
	switch typed := value.(type) {
	case nil:
		return append(destination, "null"...)
	case bool:
		return strconv.AppendBool(destination, typed)
	case float64:
		return text.AppendNumber(destination, typed)
	case string:
		return append(destination, typed...)
	case []any:
		return appendJoinedElements(destination, typed)
	case time.Time:
		return appendDateString(destination, typed)
	case []byte:
		for index, element := range typed {
			if index > 0 {
				destination = append(destination, ',')
			}
			destination = strconv.AppendUint(destination, uint64(element), 10)
		}
		return destination
	case []float32:
		for index, element := range typed {
			if index > 0 {
				destination = append(destination, ',')
			}
			destination = text.AppendNumber(destination, float64(element))
		}
		return destination
	}
	return append(destination, plainObjectText...)
}

func appendJoinedElements(destination []byte, elements []any) []byte {
	for index, element := range elements {
		if index > 0 {
			destination = append(destination, ',')
		}
		if element != nil {
			destination = appendJavaScriptString(destination, element)
		}
	}
	return destination
}

func appendPadded(destination []byte, value, width int) []byte {
	digits := strconv.Itoa(value)
	for padding := len(digits); padding < width; padding++ {
		destination = append(destination, '0')
	}
	return append(destination, digits...)
}

func appendDateString(destination []byte, moment time.Time) []byte {
	universal := moment.UTC()
	destination = append(destination, weekdayNames[universal.Weekday()]...)
	destination = append(destination, ' ')
	destination = append(destination, monthNames[universal.Month()-1]...)
	destination = append(destination, ' ')
	destination = appendPadded(destination, universal.Day(), 2)
	destination = append(destination, ' ')
	year := universal.Year()
	if year < 0 {
		destination = append(destination, '-')
		year = -year
	}
	destination = appendPadded(destination, year, 4)
	destination = append(destination, ' ')
	destination = appendPadded(destination, universal.Hour(), 2)
	destination = append(destination, ':')
	destination = appendPadded(destination, universal.Minute(), 2)
	destination = append(destination, ':')
	destination = appendPadded(destination, universal.Second(), 2)
	return append(destination, universalTimeZoneText...)
}

func javaScriptNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case float64:
		return typed
	case string:
		return stringToNumber(typed)
	case time.Time:
		return float64(typed.UnixMilli())
	case []any, []byte, []float32:
		return stringToNumber(javaScriptString(typed))
	}
	return math.NaN()
}

func isStringWhiteSpace(codePoint rune) bool {
	switch codePoint {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return codePoint >= 0x2000 && codePoint <= 0x200A
}

func trimStringWhiteSpace(source string) string {
	start := 0
	for start < len(source) {
		codePoint, size := utf8.DecodeRuneInString(source[start:])
		if !isStringWhiteSpace(codePoint) {
			break
		}
		start += size
	}
	end := len(source)
	for end > start {
		codePoint, size := utf8.DecodeLastRuneInString(source[start:end])
		if !isStringWhiteSpace(codePoint) {
			break
		}
		end -= size
	}
	return source[start:end]
}

func stringToNumber(source string) float64 {
	literal := trimStringWhiteSpace(source)
	if literal == "" {
		return 0
	}
	if len(literal) > 2 && literal[0] == '0' {
		if radix := radixOfPrefix(literal[1]); radix != 0 {
			return integerLiteralValue(literal[2:], radix)
		}
	}
	unsigned := literal
	negative := false
	if unsigned[0] == '+' || unsigned[0] == '-' {
		negative = unsigned[0] == '-'
		unsigned = unsigned[1:]
	}
	if unsigned == "Infinity" {
		if negative {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if !isUnsignedDecimalLiteral(unsigned) {
		return math.NaN()
	}
	parsed, _ := strconv.ParseFloat(literal, 64)
	return parsed
}

func radixOfPrefix(marker byte) int {
	switch marker {
	case 'x', 'X':
		return 16
	case 'o', 'O':
		return 8
	case 'b', 'B':
		return 2
	}
	return 0
}

func integerLiteralValue(digits string, radix int) float64 {
	for index := 0; index < len(digits); index++ {
		if digitValue(digits[index]) >= radix {
			return math.NaN()
		}
	}
	whole, parsed := new(big.Int).SetString(digits, radix)
	if !parsed {
		return math.NaN()
	}
	value, _ := new(big.Float).SetPrec(53).SetMode(big.ToNearestEven).SetInt(whole).Float64()
	return value
}

func digitValue(digit byte) int {
	switch {
	case digit >= '0' && digit <= '9':
		return int(digit - '0')
	case digit >= 'a' && digit <= 'z':
		return int(digit-'a') + 10
	case digit >= 'A' && digit <= 'Z':
		return int(digit-'A') + 10
	}
	return math.MaxInt
}

func leadingDigitCount(source string) int {
	count := 0
	for count < len(source) && source[count] >= '0' && source[count] <= '9' {
		count++
	}
	return count
}

func isUnsignedDecimalLiteral(source string) bool {
	whole := leadingDigitCount(source)
	rest := source[whole:]
	fraction := 0
	if strings.HasPrefix(rest, ".") {
		rest = rest[1:]
		fraction = leadingDigitCount(rest)
		rest = rest[fraction:]
	}
	if whole == 0 && fraction == 0 {
		return false
	}
	if rest == "" {
		return true
	}
	if rest[0] != 'e' && rest[0] != 'E' {
		return false
	}
	rest = rest[1:]
	if rest != "" && (rest[0] == '+' || rest[0] == '-') {
		rest = rest[1:]
	}
	exponent := leadingDigitCount(rest)
	return exponent > 0 && exponent == len(rest)
}
