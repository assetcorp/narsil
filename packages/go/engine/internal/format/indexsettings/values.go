package indexsettings

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Case uint8

const (
	Snake Case = iota
	Camel
)

func (keyCase Case) Key(snake string, camel string) string {
	if keyCase == Camel {
		return camel
	}
	return snake
}

func Invalid(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, message, details)
}

func AsMap(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func AsString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

func AsStrings(value any) ([]string, bool) {
	list, ok := value.([]any)
	if !ok {
		return nil, false
	}
	texts := make([]string, len(list))
	for index, element := range list {
		text, isText := element.(string)
		if !isText {
			return nil, false
		}
		texts[index] = text
	}
	return texts, true
}

func AsInteger(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return 0, false
	}
	return number, true
}

func AsSafeInteger(value any) (int64, bool) {
	number, ok := AsInteger(value)
	if !ok || math.Abs(number) > form.MaxSafeInteger {
		return 0, false
	}
	return int64(number), true
}

func AsPositive(value any, maximum uint64) (uint64, bool) {
	number, ok := AsSafeInteger(value)
	if !ok || number < 1 || uint64(number) > maximum {
		return 0, false
	}
	return uint64(number), true
}

func AsCount(value any, maximum uint64) (uint64, bool) {
	number, ok := AsSafeInteger(value)
	if !ok || number < 0 || uint64(number) > maximum {
		return 0, false
	}
	return uint64(number), true
}

func AsFinite(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func Present(record map[string]any, key string) (any, bool) {
	value, ok := record[key]
	return value, ok && value != nil
}

func Put(entries *codec.OrderedMap, key string, value any) {
	*entries = append(*entries, codec.MapEntry{Key: key, Value: value})
}

func PutOptional[T any](entries *codec.OrderedMap, key string, value model.Optional[T], convert func(T) any) {
	if present, ok := value.Get(); ok {
		Put(entries, key, convert(present))
	}
}

func Number[T ~int64 | ~uint64 | ~uint32 | ~uint16 | ~float64](value T) any {
	return float64(value)
}

func Text(value string) any {
	return value
}

func Flag(value bool) any {
	return value
}

func Texts(values []string) any {
	return form.StringValues(values)
}
