package cursor

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const lowercaseHexDigits = "0123456789abcdef"

func appendJSONString(destination []byte, value string) []byte {
	value = text.ToWellFormed(value)
	destination = append(destination, '"')
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch character {
		case '"':
			destination = append(destination, '\\', '"')
		case '\\':
			destination = append(destination, '\\', '\\')
		case '\b':
			destination = append(destination, '\\', 'b')
		case '\f':
			destination = append(destination, '\\', 'f')
		case '\n':
			destination = append(destination, '\\', 'n')
		case '\r':
			destination = append(destination, '\\', 'r')
		case '\t':
			destination = append(destination, '\\', 't')
		default:
			if character < jsonFirstPrintable {
				destination = append(destination, '\\', 'u', '0', '0', lowercaseHexDigits[character>>4], lowercaseHexDigits[character&0x0F])
				continue
			}
			destination = append(destination, character)
		}
	}
	return append(destination, '"')
}

func appendJSONNumber(destination []byte, value float64) []byte {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return append(destination, "null"...)
	}
	return text.AppendNumber(destination, value)
}

func appendJSONSortValue(destination []byte, value text.SortValue) []byte {
	switch value.Kind {
	case text.SortValueNumber:
		return appendJSONNumber(destination, value.Number)
	case text.SortValueString:
		return appendJSONString(destination, text.TruncateSortString(value.Text))
	case text.SortValueBoolean:
		if value.Boolean {
			return append(destination, "true"...)
		}
		return append(destination, "false"...)
	}
	return append(destination, "null"...)
}

func appendJavaScriptString(destination []byte, value jsonValue) []byte {
	switch value.kind {
	case jsonNull:
		return append(destination, "null"...)
	case jsonFalse:
		return append(destination, "false"...)
	case jsonTrue:
		return append(destination, "true"...)
	case jsonNumber:
		return text.AppendNumber(destination, value.number)
	case jsonString:
		return append(destination, value.text...)
	case jsonObject:
		return append(destination, "[object Object]"...)
	}
	for index, item := range value.items {
		if index > 0 {
			destination = append(destination, ',')
		}
		if item.kind != jsonNull {
			destination = appendJavaScriptString(destination, item)
		}
	}
	return destination
}
