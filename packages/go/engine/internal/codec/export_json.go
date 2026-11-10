package codec

import (
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	TagPrefix  = "$"
	DateTag    = "$date"
	BytesTag   = "$bytes"
	NumberTag  = "$number"
	ObjectTag  = "$object"
	hexDigits  = "0123456789abcdef"
	jsonEscape = '\\'
)

type jsonLineTarget struct {
	documentID string
	tagged     bool
	output     []byte
}

func (target *jsonLineTarget) refuse(path string, kind string) error {
	shownPath := path
	if shownPath == "" {
		shownPath = "(document)"
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		`Document "`+target.documentID+`" holds `+kind+` at "`+shownPath+`", which a document export cannot carry as JSON`,
		map[string]any{"docId": target.documentID, "field": path},
	)
}

func AppendJSONString(destination []byte, value string) []byte {
	destination = append(destination, '"')
	for at := 0; at < len(value); {
		character := value[at]
		if character >= utf8.RuneSelf {
			codePoint, size := text.NextCodePoint(value, at)
			destination = utf8.AppendRune(destination, codePoint)
			at += size
			continue
		}
		at++
		switch character {
		case '"', jsonEscape:
			destination = append(destination, jsonEscape, character)
		case '\b':
			destination = append(destination, jsonEscape, 'b')
		case '\f':
			destination = append(destination, jsonEscape, 'f')
		case '\n':
			destination = append(destination, jsonEscape, 'n')
		case '\r':
			destination = append(destination, jsonEscape, 'r')
		case '\t':
			destination = append(destination, jsonEscape, 't')
		default:
			if character < ' ' {
				destination = append(destination, jsonEscape, 'u', '0', '0', hexDigits[character>>4], hexDigits[character&0xF])
			} else {
				destination = append(destination, character)
			}
		}
	}
	return append(destination, '"')
}

func (target *jsonLineTarget) appendNumber(value float64, path string) error {
	switch {
	case !math.IsNaN(value) && !math.IsInf(value, 0):
		if IsNegativeZero(value) {
			target.output = append(target.output, '-', '0')
			return nil
		}
		target.output = text.AppendNumber(target.output, value)
		return nil
	case !target.tagged:
		return target.refuse(path, text.FormatNumber(value))
	}
	target.output = append(target.output, `{"`+NumberTag+`":"`...)
	target.output = text.AppendNumber(target.output, value)
	target.output = append(target.output, '"', '}')
	return nil
}

func (target *jsonLineTarget) appendDate(moment time.Time, path string) error {
	if !target.tagged {
		return target.refuse(path, "a date")
	}
	seconds := moment.Unix()
	if seconds > maxSafeInteger || seconds < -maxSafeInteger {
		return target.refuse(path, "a date whose seconds lie outside the range of a float64 integer")
	}
	target.output = append(target.output, `{"`+DateTag+`":[`...)
	target.output = strconv.AppendInt(target.output, seconds, 10)
	target.output = append(target.output, ',')
	target.output = strconv.AppendInt(target.output, int64(moment.Nanosecond()), 10)
	target.output = append(target.output, ']', '}')
	return nil
}

func (target *jsonLineTarget) appendBytes(bytes []byte, path string) error {
	if !target.tagged {
		return target.refuse(path, "bytes")
	}
	target.output = append(target.output, `{"`+BytesTag+`":"`...)
	target.output = AppendBase64(target.output, bytes)
	target.output = append(target.output, '"', '}')
	return nil
}

func listPath(path string, index int) string {
	return path + "[" + strconv.Itoa(index) + "]"
}

func fieldPath(path string, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func (target *jsonLineTarget) appendList(length int, elementAt func(int) any, path string) error {
	target.output = append(target.output, '[')
	for index := range length {
		if index > 0 {
			target.output = append(target.output, ',')
		}
		if err := target.appendValue(elementAt(index), listPath(path, index)); err != nil {
			return err
		}
	}
	target.output = append(target.output, ']')
	return nil
}

func (target *jsonLineTarget) appendEntries(entries OrderedMap, path string) error {
	wrapped := target.tagged && len(entries) == 1 && strings.HasPrefix(entries[0].Key, TagPrefix)
	if wrapped {
		target.output = append(target.output, `{"`+ObjectTag+`":{`...)
	} else {
		target.output = append(target.output, '{')
	}
	for index, entry := range entries {
		if index > 0 {
			target.output = append(target.output, ',')
		}
		target.output = AppendJSONString(target.output, entry.Key)
		target.output = append(target.output, ':')
		if err := target.appendValue(entry.Value, fieldPath(path, entry.Key)); err != nil {
			return err
		}
	}
	if wrapped {
		target.output = append(target.output, '}', '}')
	} else {
		target.output = append(target.output, '}')
	}
	return nil
}

func entriesOf(record map[string]any) OrderedMap {
	entries := make(OrderedMap, 0, len(record))
	for _, key := range ObjectKeyOrder(record) {
		entries = append(entries, MapEntry{Key: key, Value: record[key]})
	}
	return entries
}

func (target *jsonLineTarget) appendValue(value any, path string) error {
	switch typed := value.(type) {
	case nil:
		target.output = append(target.output, "null"...)
	case string:
		target.output = AppendJSONString(target.output, typed)
	case bool:
		target.output = strconv.AppendBool(target.output, typed)
	case float64:
		return target.appendNumber(typed, path)
	case []any:
		return target.appendList(len(typed), func(index int) any { return typed[index] }, path)
	case []float32:
		return target.appendList(len(typed), func(index int) any { return float64(typed[index]) }, path)
	case []float64:
		return target.appendList(len(typed), func(index int) any { return typed[index] }, path)
	case []string:
		return target.appendList(len(typed), func(index int) any { return typed[index] }, path)
	case time.Time:
		return target.appendDate(typed, path)
	case []byte:
		return target.appendBytes(typed, path)
	case map[string]any:
		return target.appendEntries(entriesOf(typed), path)
	case OrderedMap:
		return target.appendEntries(typed, path)
	case InvalidDate:
		return target.refuse(path, "a date")
	default:
		return target.refuse(path, "a value other than a plain object")
	}
	return nil
}

func AppendExactJSON(destination []byte, value any, documentID string) ([]byte, error) {
	target := jsonLineTarget{documentID: documentID, output: destination}
	if err := target.appendValue(value, ""); err != nil {
		return destination, err
	}
	return target.output, nil
}

func AppendDocumentJSON(destination []byte, document any, documentID string) ([]byte, error) {
	target := jsonLineTarget{documentID: documentID, tagged: true, output: destination}
	if err := target.appendValue(document, ""); err != nil {
		return destination, err
	}
	return target.output, nil
}
