package fields

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	narsiltext "github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func numberOf(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int8:
		return float64(typed), true
	case int16:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint8:
		return float64(typed), true
	case uint16:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	}
	return 0, false
}

func kindName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case *codec.Document:
		return "object"
	}
	if _, isNumber := numberOf(value); isNumber {
		return "number"
	}
	return "object"
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func checkText(path, text string, index int) error {
	if !utf8.ValidString(text) {
		return invalidValue(path, "holds an unpaired surrogate or bytes that are not UTF-8, so no field index can hold it",
			elementDetails(index))
	}
	if len(text) > maxStringUnits && narsiltext.UTF16Length(text) > maxStringUnits {
		return invalidValue(path, "holds a string longer than 1,073,741,824 UTF-16 code units", elementDetails(index))
	}
	return nil
}

func elementDetails(index int) map[string]any {
	if index < 0 {
		return nil
	}
	return map[string]any{"index": float64(index)}
}

func listOf(path string, value any) ([]any, error) {
	list, isList := value.([]any)
	if !isList {
		return nil, invalidValue(path, "expected an array, got "+kindName(value), map[string]any{"received": kindName(value)})
	}
	return list, nil
}

func finiteNumber(path string, value any, index int) (float64, error) {
	number, isNumber := numberOf(value)
	if !isNumber {
		return 0, invalidValue(path, "expected a number, got "+kindName(value), elementDetails(index))
	}
	if !isFinite(number) {
		return 0, invalidValue(path, "holds "+strconv.FormatFloat(number, 'g', -1, 64)+", while a number field holds finite numbers alone",
			elementDetails(index))
	}
	return number, nil
}

func booleanOf(path string, value any, index int) (bool, error) {
	flag, isBool := value.(bool)
	if !isBool {
		return false, invalidValue(path, "expected a boolean, got "+kindName(value), elementDetails(index))
	}
	return flag, nil
}

func textOf(path string, value any, index int) (string, error) {
	text, isText := value.(string)
	if !isText {
		return "", invalidValue(path, "expected a string, got "+kindName(value), elementDetails(index))
	}
	return text, checkText(path, text, index)
}

type geopoint struct {
	lat float64
	lon float64
}

func geopointOf(path string, value any) (geopoint, error) {
	record, isRecord := value.(*codec.Document)
	if !isRecord {
		return geopoint{}, invalidGeopoint(path, "expected a geopoint object with lat and lon")
	}
	heldLat, _ := codec.HeldValue(record, "lat")
	heldLon, _ := codec.HeldValue(record, "lon")
	lat, latIsNumber := numberOf(heldLat)
	lon, lonIsNumber := numberOf(heldLon)
	if !latIsNumber || !lonIsNumber || math.IsNaN(lat) || math.IsNaN(lon) {
		return geopoint{}, invalidGeopoint(path, "geopoint requires numeric lat and lon")
	}
	if !(lat >= -maxLatitudeDegrees && lat <= maxLatitudeDegrees) {
		return geopoint{}, invalidGeopoint(path, "geopoint lat must be between -90 and 90")
	}
	if !(lon >= -maxLongitudeDegrees && lon <= maxLongitudeDegrees) {
		return geopoint{}, invalidGeopoint(path, "geopoint lon must be between -180 and 180")
	}
	return geopoint{lat: lat, lon: lon}, nil
}

func nestedValue(document *codec.Document, path string) (any, bool) {
	if document == nil {
		return nil, false
	}
	if !strings.Contains(path, ".") {
		return codec.HeldValue(document, path)
	}
	var current any = document
	for part := range strings.SplitSeq(path, ".") {
		switch typed := current.(type) {
		case *codec.Document:
			value, found := codec.HeldValue(typed, part)
			if !found {
				return nil, false
			}
			current = value
		case []any:
			index, isIndex := listIndexOf(part)
			if !isIndex || index >= len(typed) {
				return nil, false
			}
			current = typed[index]
		default:
			return nil, false
		}
	}
	return current, true
}

func listIndexOf(part string) (int, bool) {
	if part == "" || (len(part) > 1 && part[0] == '0') {
		return 0, false
	}
	index, err := strconv.ParseUint(part, 10, 32)
	if err != nil || index == layoutCountLimit {
		return 0, false
	}
	return int(index), true
}

func presentValue(value any, found bool) bool {
	return found && value != nil
}
