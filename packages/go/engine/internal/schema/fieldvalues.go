package schema

import (
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func typeofStored(value any) string {
	switch value.(type) {
	case nil:
		return "undefined"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	default:
		return "object"
	}
}

func receivedKind(value any) string {
	if _, isList := value.([]any); isList {
		return "array"
	}
	return typeofStored(value)
}

func isFinite(number float64) bool {
	return !math.IsNaN(number) && !math.IsInf(number, 0)
}

func isStoredObject(value any) bool {
	switch value.(type) {
	case nil, bool, float64, string, []any:
		return false
	default:
		return true
	}
}

func validateGeopoint(path string, value any) error {
	point, isDocument := value.(*model.Document)
	if !isStoredObject(value) {
		return narsilerr.New(narsilerr.CodeSchemaInvalidGeopoint, fmt.Sprintf("Field %q expected a geopoint object with lat and lon", path), map[string]any{"field": path, "received": receivedKind(value)})
	}
	heldLat, _ := codec.HeldValue(point, "lat")
	heldLon, _ := codec.HeldValue(point, "lon")
	lat, latIsNumber := heldLat.(float64)
	lon, lonIsNumber := heldLon.(float64)
	if !isDocument || !latIsNumber || !lonIsNumber || math.IsNaN(lat) || math.IsNaN(lon) {
		return narsilerr.New(narsilerr.CodeSchemaInvalidGeopoint, fmt.Sprintf("Field %q geopoint requires numeric lat and lon", path), map[string]any{"field": path})
	}
	if lat < -MaxLatitudeDegrees || lat > MaxLatitudeDegrees {
		return narsilerr.New(narsilerr.CodeSchemaInvalidGeopoint, fmt.Sprintf("Field %q geopoint lat must be between -90 and 90", path), map[string]any{"field": path, "lat": lat})
	}
	if lon < -MaxLongitudeDegrees || lon > MaxLongitudeDegrees {
		return narsilerr.New(narsilerr.CodeSchemaInvalidGeopoint, fmt.Sprintf("Field %q geopoint lon must be between -180 and 180", path), map[string]any{"field": path, "lon": lon})
	}
	return nil
}

func validateVector(path string, value any, dimension int) error {
	var length int
	var element func(int) (float64, bool)
	switch typed := value.(type) {
	case []float32:
		length = len(typed)
		element = func(i int) (float64, bool) { return float64(typed[i]), true }
	case []any:
		length = len(typed)
		element = func(i int) (float64, bool) {
			number, isNumber := typed[i].(float64)
			return number, isNumber
		}
	default:
		return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q expected a vector (list of numbers)", path), map[string]any{"field": path, "received": typeofStored(value)})
	}
	if length != dimension {
		return narsilerr.New(
			narsilerr.CodeDocValidationFailed,
			fmt.Sprintf("Field %q expected vector of dimension %d, got %d", path, dimension, length),
			map[string]any{"field": path, "expected": dimension, "received": length},
		)
	}
	for i := 0; i < length; i++ {
		number, isNumber := element(i)
		if !isNumber || !Float32Representable(number) {
			return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q vector element at index %d is not a valid number", path, i), map[string]any{"field": path, "index": i})
		}
	}
	return nil
}

func validateTypedList(path string, value any, elementType string) error {
	items, isList := value.([]any)
	if !isList {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q expected an array", path), map[string]any{"field": path, "received": typeofStored(value)})
	}
	for i, item := range items {
		received := typeofStored(item)
		if received != elementType {
			return narsilerr.New(
				narsilerr.CodeDocValidationFailed,
				fmt.Sprintf("Field %q array element at index %d expected %s, got %s", path, i, elementType, received),
				map[string]any{"field": path, "index": i, "expected": elementType, "received": received},
			)
		}
		if number, isNumber := item.(float64); isNumber && !isFinite(number) {
			return narsilerr.New(
				narsilerr.CodeDocValidationFailed,
				fmt.Sprintf("Field %q array element at index %d is %s, while a number field holds finite numbers alone", path, i, describeNumber(number)),
				map[string]any{"field": path, "index": i},
			)
		}
	}
	return nil
}

func describeNumber(number float64) string {
	switch {
	case math.IsNaN(number):
		return "NaN"
	case math.IsInf(number, 1):
		return "Infinity"
	case math.IsInf(number, -1):
		return "-Infinity"
	default:
		return strconv.FormatFloat(number, 'g', -1, 64)
	}
}

func validatePatternValue(path, value string, limit int, index int) error {
	if utf8.RuneCountInString(value) <= limit {
		return nil
	}
	subject := fmt.Sprintf("The value of field %q", path)
	details := map[string]any{"field": path, "limit": limit}
	if index >= 0 {
		subject = fmt.Sprintf("Element %d of field %q", index, path)
		details["index"] = index
	}
	return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("%s is longer than %d code points, which is the pattern value limit of this index", subject, limit), details)
}

func validateText(path string, value any, expected string) error {
	if _, isText := value.(string); isText {
		return nil
	}
	received := typeofStored(value)
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		fmt.Sprintf("Field %q expected %s, got %s", path, expected, received),
		map[string]any{"field": path, "expected": expected, "received": received},
	)
}

func validateFieldValue(path string, value any, field ParsedFieldType, limit int) error {
	switch field.Base {
	case BaseString, BaseVerbatim:
		if err := validateText(path, value, "string"); err != nil {
			return err
		}
		if field.Pattern {
			return validatePatternValue(path, value.(string), limit, -1)
		}
		return nil
	case BaseNumber:
		number, isNumber := value.(float64)
		if !isNumber || !isFinite(number) {
			received := typeofStored(value)
			if isNumber {
				received = describeNumber(number)
			}
			return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q expected a finite number", path), map[string]any{"field": path, "expected": "number", "received": received})
		}
		return nil
	case BaseBoolean:
		if _, isBoolean := value.(bool); isBoolean {
			return nil
		}
		received := typeofStored(value)
		return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q expected boolean, got %s", path, received), map[string]any{"field": path, "expected": "boolean", "received": received})
	case BaseEnum:
		return validateText(path, value, "enum (string)")
	case BaseGeopoint:
		return validateGeopoint(path, value)
	case BaseStringList, BaseVerbatimList:
		if err := validateTypedList(path, value, "string"); err != nil {
			return err
		}
		if field.Pattern {
			for i, item := range value.([]any) {
				if err := validatePatternValue(path, item.(string), limit, i); err != nil {
					return err
				}
			}
		}
		return nil
	case BaseNumberList:
		return validateTypedList(path, value, "number")
	case BaseBooleanList:
		return validateTypedList(path, value, "boolean")
	case BaseEnumList:
		return validateTypedList(path, value, "string")
	case BaseVector:
		return validateVector(path, value, field.Dimension)
	}
	return nil
}
