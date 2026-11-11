package cursor

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type jsonKind uint8

const (
	jsonNull jsonKind = iota
	jsonFalse
	jsonTrue
	jsonNumber
	jsonString
	jsonArray
	jsonObject
)

const (
	jsonEscapeHexDigits = 4
	jsonFirstPrintable  = 0x20
)

type jsonValue struct {
	kind    jsonKind
	number  float64
	text    string
	items   []jsonValue
	members map[string]jsonValue
}

type jsonParser struct {
	source string
	at     int
}

func parseJSON(source string) (jsonValue, bool) {
	parser := jsonParser{source: source}
	parser.skipWhitespace()
	value, parsed := parser.value()
	if !parsed {
		return jsonValue{}, false
	}
	parser.skipWhitespace()
	return value, parser.at == len(source)
}

func (parser *jsonParser) skipWhitespace() {
	for parser.at < len(parser.source) {
		switch parser.source[parser.at] {
		case ' ', '\t', '\n', '\r':
			parser.at++
		default:
			return
		}
	}
}

func (parser *jsonParser) literal(word string, value jsonValue) (jsonValue, bool) {
	if !strings.HasPrefix(parser.source[parser.at:], word) {
		return jsonValue{}, false
	}
	parser.at += len(word)
	return value, true
}

func (parser *jsonParser) value() (jsonValue, bool) {
	if parser.at >= len(parser.source) {
		return jsonValue{}, false
	}
	switch character := parser.source[parser.at]; {
	case character == '{':
		return parser.object()
	case character == '[':
		return parser.array()
	case character == '"':
		parsed, found := parser.string()
		return jsonValue{kind: jsonString, text: parsed}, found
	case character == 't':
		return parser.literal("true", jsonValue{kind: jsonTrue})
	case character == 'f':
		return parser.literal("false", jsonValue{kind: jsonFalse})
	case character == 'n':
		return parser.literal("null", jsonValue{kind: jsonNull})
	case character == '-' || isDigit(character):
		return parser.number()
	}
	return jsonValue{}, false
}

func (parser *jsonParser) consume(character byte) bool {
	if parser.at < len(parser.source) && parser.source[parser.at] == character {
		parser.at++
		return true
	}
	return false
}

func (parser *jsonParser) object() (jsonValue, bool) {
	parser.at++
	object := jsonValue{kind: jsonObject, members: map[string]jsonValue{}}
	parser.skipWhitespace()
	if parser.consume('}') {
		return object, true
	}
	for {
		if parser.at >= len(parser.source) || parser.source[parser.at] != '"' {
			return jsonValue{}, false
		}
		key, found := parser.string()
		if !found {
			return jsonValue{}, false
		}
		parser.skipWhitespace()
		if !parser.consume(':') {
			return jsonValue{}, false
		}
		parser.skipWhitespace()
		member, parsed := parser.value()
		if !parsed {
			return jsonValue{}, false
		}
		object.members[key] = member
		parser.skipWhitespace()
		if parser.consume('}') {
			return object, true
		}
		if !parser.consume(',') {
			return jsonValue{}, false
		}
		parser.skipWhitespace()
	}
}

func (parser *jsonParser) array() (jsonValue, bool) {
	parser.at++
	array := jsonValue{kind: jsonArray}
	parser.skipWhitespace()
	if parser.consume(']') {
		return array, true
	}
	for {
		item, parsed := parser.value()
		if !parsed {
			return jsonValue{}, false
		}
		array.items = append(array.items, item)
		parser.skipWhitespace()
		if parser.consume(']') {
			return array, true
		}
		if !parser.consume(',') {
			return jsonValue{}, false
		}
		parser.skipWhitespace()
	}
}

func (parser *jsonParser) string() (string, bool) {
	parser.at++
	var units []uint16
	for parser.at < len(parser.source) {
		character := parser.source[parser.at]
		switch {
		case character == '"':
			parser.at++
			return text.DecodeUTF16(units), true
		case character < jsonFirstPrintable:
			return "", false
		case character == '\\':
			unit, escaped := parser.escape()
			if !escaped {
				return "", false
			}
			units = append(units, unit)
		default:
			codePoint, size := text.NextCodePoint(parser.source, parser.at)
			units = utf16.AppendRune(units, codePoint)
			parser.at += size
		}
	}
	return "", false
}

func (parser *jsonParser) escape() (uint16, bool) {
	parser.at++
	if parser.at >= len(parser.source) {
		return 0, false
	}
	character := parser.source[parser.at]
	parser.at++
	switch character {
	case '"', '\\', '/':
		return uint16(character), true
	case 'b':
		return '\b', true
	case 'f':
		return '\f', true
	case 'n':
		return '\n', true
	case 'r':
		return '\r', true
	case 't':
		return '\t', true
	case 'u':
		return parser.escapedUnit()
	}
	return 0, false
}

func (parser *jsonParser) escapedUnit() (uint16, bool) {
	if parser.at+jsonEscapeHexDigits > len(parser.source) {
		return 0, false
	}
	var unit uint16
	for range jsonEscapeHexDigits {
		digit, valid := hexDigitValue(parser.source[parser.at])
		if !valid {
			return 0, false
		}
		unit = unit<<4 | digit
		parser.at++
	}
	return unit, true
}

func hexDigitValue(character byte) (uint16, bool) {
	switch {
	case isDigit(character):
		return uint16(character - '0'), true
	case character >= 'a' && character <= 'f':
		return uint16(character-'a') + 10, true
	case character >= 'A' && character <= 'F':
		return uint16(character-'A') + 10, true
	}
	return 0, false
}

func isDigit(character byte) bool {
	return character >= '0' && character <= '9'
}

func (parser *jsonParser) digits() int {
	start := parser.at
	for parser.at < len(parser.source) && isDigit(parser.source[parser.at]) {
		parser.at++
	}
	return parser.at - start
}

func (parser *jsonParser) number() (jsonValue, bool) {
	start := parser.at
	parser.consume('-')
	if parser.consume('0') {
		if parser.at < len(parser.source) && isDigit(parser.source[parser.at]) {
			return jsonValue{}, false
		}
	} else if parser.digits() == 0 {
		return jsonValue{}, false
	}
	if parser.consume('.') && parser.digits() == 0 {
		return jsonValue{}, false
	}
	if parser.consume('e') || parser.consume('E') {
		if !parser.consume('+') {
			parser.consume('-')
		}
		if parser.digits() == 0 {
			return jsonValue{}, false
		}
	}
	number, err := strconv.ParseFloat(parser.source[start:parser.at], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return jsonValue{}, false
	}
	return jsonValue{kind: jsonNumber, number: number}, true
}
