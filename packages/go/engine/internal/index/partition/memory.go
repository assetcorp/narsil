package partition

import (
	"time"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func textFieldsChanged(previous, next map[string]any, fields []schema.Field) bool {
	for _, field := range fields {
		if !field.IsWordIndexed() {
			continue
		}
		previousValue, previousFound := NestedValue(previous, field.Path)
		nextValue, nextFound := NestedValue(next, field.Path)
		if previousFound != nextFound {
			return true
		}
		if field.Base == schema.BaseString {
			if !sameScalar(previousValue, nextValue) {
				return true
			}
			continue
		}
		if !sameStringList(previousValue, nextValue) {
			return true
		}
	}
	return false
}

func sameScalar(left, right any) bool {
	switch typed := left.(type) {
	case nil:
		return right == nil
	case string:
		other, isString := right.(string)
		return isString && other == typed
	case float64:
		other, isNumber := right.(float64)
		return isNumber && other == typed
	case bool:
		other, isBool := right.(bool)
		return isBool && other == typed
	}
	return false
}

func sameStringList(left, right any) bool {
	if left == nil && right == nil {
		return true
	}
	leftItems, leftIsList := left.([]any)
	rightItems, rightIsList := right.([]any)
	if !leftIsList || !rightIsList || len(leftItems) != len(rightItems) {
		return false
	}
	for index := range leftItems {
		if !sameScalar(leftItems[index], rightItems[index]) {
			return false
		}
	}
	return true
}

func stringBytes(value string) int {
	units := len(utf16.Encode([]rune(value)))
	sampled := 0
	for _, character := range value {
		if sampled == twoByteSampleLimit {
			break
		}
		if character > 0xff {
			return stringHeaderBytes + units*2
		}
		sampled++
	}
	return stringHeaderBytes + units
}

func DocumentValueBytes(value any, depth int) int {
	if depth > maxCompareDepth {
		return primitiveSlotBytes
	}
	switch typed := value.(type) {
	case string:
		return stringBytes(typed)
	case float64:
		return numberBytes
	case nil, bool:
		return primitiveSlotBytes
	case []float32:
		return typedArrayHeaderBytes + len(typed)*4
	case []byte:
		return typedArrayHeaderBytes + len(typed)
	case time.Time:
		return objectHeaderBytes
	case []any:
		bytes := arrayHeaderBytes + len(typed)*arraySlotBytes
		for _, item := range typed {
			bytes += DocumentValueBytes(item, depth+1)
		}
		return bytes
	case map[string]any:
		bytes := objectHeaderBytes
		for _, item := range typed {
			bytes += propertySlotBytes + DocumentValueBytes(item, depth+1)
		}
		return bytes
	}
	return primitiveSlotBytes
}
