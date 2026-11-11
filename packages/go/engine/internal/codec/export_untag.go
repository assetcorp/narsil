package codec

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const escapedTagPrefix = "\\u0024"

func refuseTag(path string, reason string) error {
	shownPath := path
	if shownPath == "" {
		shownPath = "(document)"
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		`Field "`+shownPath+`" `+reason,
		map[string]any{"field": path},
	)
}

func soleTagKey(record map[string]any) (string, bool) {
	if len(record) != 1 {
		return "", false
	}
	for key := range record {
		return key, strings.HasPrefix(key, TagPrefix)
	}
	return "", false
}

func isWholeNumber(value float64) bool {
	return !math.IsInf(value, 0) && value == math.Trunc(value)
}

func untagDate(value any, path string) (time.Time, error) {
	pair, isList := value.([]any)
	if !isList || len(pair) != 2 {
		return time.Time{}, refuseTag(path, `holds a "`+DateTag+`" tag other than [seconds, nanoseconds]`)
	}
	seconds, secondsAreNumber := pair[0].(float64)
	if !secondsAreNumber || !isSafeInteger(seconds) {
		return time.Time{}, refuseTag(path, `holds a "`+DateTag+`" tag whose seconds are not an integer from -`+
			strconv.FormatInt(maxSafeInteger, 10)+` to `+strconv.FormatInt(maxSafeInteger, 10))
	}
	nanoseconds, nanosecondsAreNumber := pair[1].(float64)
	if !nanosecondsAreNumber || !isWholeNumber(nanoseconds) || nanoseconds < 0 || nanoseconds > maxTimestampNanoseconds {
		return time.Time{}, refuseTag(path, `holds a "`+DateTag+`" tag whose nanoseconds are not an integer from 0 to `+
			strconv.Itoa(maxTimestampNanoseconds))
	}
	milliseconds := float64(seconds*millisecondsPerSecond) + nanoseconds/nanosecondsPerMillisecond
	if math.Abs(milliseconds) > maxDateMilliseconds {
		return time.Time{}, refuseTag(path, `holds a "`+DateTag+`" tag outside the range of a date`)
	}
	return time.Unix(int64(seconds), int64(nanoseconds)), nil
}

func untagBytes(value any, path string) ([]byte, error) {
	encoded, isString := value.(string)
	if isString {
		if bytes, valid := DecodeExactBase64(encoded); valid {
			return bytes, nil
		}
	}
	return nil, refuseTag(path, `holds a "`+BytesTag+`" tag whose text is not padded base64`)
}

func untagNumber(value any, path string) (float64, error) {
	switch value {
	case "NaN":
		return JavaScriptNaN(), nil
	case "Infinity":
		return math.Inf(1), nil
	case "-Infinity":
		return math.Inf(-1), nil
	}
	return 0, refuseTag(path, `holds a "`+NumberTag+`" tag other than "NaN", "Infinity", or "-Infinity"`)
}

func requireExportDepth(path string, depth int) error {
	if depth >= MaxExportNestingDepth {
		return refuseTag(path, "nests deeper than "+strconv.Itoa(MaxExportNestingDepth)+" levels")
	}
	return nil
}

func untagMap(record map[string]any, path string, depth int) (map[string]any, error) {
	if err := requireExportDepth(path, depth); err != nil {
		return nil, err
	}
	for _, key := range ObjectKeyOrder(record) {
		value, err := untagValue(record[key], fieldPath(path, key), depth+1)
		if err != nil {
			return nil, err
		}
		record[key] = value
	}
	return record, nil
}

func untagList(list []any, path string, depth int) ([]any, error) {
	if err := requireExportDepth(path, depth); err != nil {
		return nil, err
	}
	for index, element := range list {
		value, err := untagValue(element, listPath(path, index), depth+1)
		if err != nil {
			return nil, err
		}
		list[index] = value
	}
	return list, nil
}

func untagTag(tag string, value any, path string, depth int) (any, error) {
	switch tag {
	case DateTag:
		return untagDate(value, path)
	case BytesTag:
		return untagBytes(value, path)
	case NumberTag:
		return untagNumber(value, path)
	case ObjectTag:
		record, isRecord := value.(map[string]any)
		if !isRecord {
			return nil, refuseTag(path, `holds an "`+ObjectTag+`" tag whose value is not an object`)
		}
		return untagMap(record, path, depth)
	}
	return nil, refuseTag(path, `holds an object whose only key, "`+tag+`", names no tag`)
}

func untagValue(value any, path string, depth int) (any, error) {
	switch typed := value.(type) {
	case []any:
		return untagList(typed, path, depth)
	case map[string]any:
		if tag, isTag := soleTagKey(typed); isTag {
			return untagTag(tag, typed[tag], path, depth)
		}
		return untagMap(typed, path, depth)
	}
	return value, nil
}

func UntagDocumentLine(line string, parsed map[string]any) (map[string]any, error) {
	if !strings.Contains(line, `"`+TagPrefix) && !strings.Contains(line, escapedTagPrefix) {
		return parsed, nil
	}
	return untagMap(parsed, "", 0)
}
