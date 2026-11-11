package codec

import (
	"bytes"
	"encoding/json"
	"strconv"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	unicodeEscapeDigits = 4
	highSurrogateLow    = 0xD800
	lowSurrogateLow     = 0xDC00
	surrogateHigh       = 0xE000
)

func hexValue(digits []byte) (int, bool) {
	value, err := strconv.ParseUint(string(digits), 16, 32)
	return int(value), err == nil
}

func unicodeEscapeAt(line []byte, at int) (int, bool) {
	if at+2+unicodeEscapeDigits > len(line) || line[at] != '\\' || line[at+1] != 'u' {
		return 0, false
	}
	return hexValue(line[at+2 : at+2+unicodeEscapeDigits])
}

func holdsLoneSurrogateEscape(line []byte) bool {
	inString := false
	for at := 0; at < len(line); at++ {
		character := line[at]
		if !inString {
			inString = character == '"'
			continue
		}
		switch character {
		case '"':
			inString = false
		case '\\':
			unit, isUnicode := unicodeEscapeAt(line, at)
			if !isUnicode {
				at++
				continue
			}
			at += 1 + unicodeEscapeDigits
			if unit >= lowSurrogateLow && unit < surrogateHigh {
				return true
			}
			if unit >= highSurrogateLow && unit < lowSurrogateLow {
				low, pairs := unicodeEscapeAt(line, at+1)
				if !pairs || low < lowSurrogateLow || low >= surrogateHigh {
					return true
				}
				at += 2 + unicodeEscapeDigits
			}
		}
	}
	return false
}

func refuseLine(code string, message string) error {
	return narsilerr.New(code, message, nil)
}

func ParseJSON(line []byte, code string) (any, error) {
	if !utf8.Valid(line) {
		return nil, refuseLine(code, "The line is not UTF-8")
	}
	if holdsLoneSurrogateEscape(line) {
		return nil, refuseLine(code, "The line holds a lone surrogate, which a document cannot hold")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, narsilerr.Wrap(code, "The line is not JSON", err, nil)
	}
	if len(bytes.TrimLeft(line[decoder.InputOffset():], " \t\r\n")) != 0 {
		return nil, refuseLine(code, "The line holds more than one JSON value")
	}
	return withNumbers(parsed), nil
}

func withNumbers(value any) any {
	switch typed := value.(type) {
	case json.Number:
		number, _ := strconv.ParseFloat(string(typed), 64)
		return number
	case []any:
		for index, element := range typed {
			typed[index] = withNumbers(element)
		}
		return typed
	case map[string]any:
		for key, element := range typed {
			typed[key] = withNumbers(element)
		}
		return typed
	}
	return value
}
