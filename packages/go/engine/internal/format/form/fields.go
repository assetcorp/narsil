package form

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const MaxSafeInteger = 9_007_199_254_740_991

type Fields struct {
	values map[string]any
	path   string
	code   string
	what   string
	err    *error
}

func NewFields(value any, path string, code string, what string) *Fields {
	var err error
	fields := &Fields{path: path, code: code, what: what, err: &err}
	record, ok := value.(map[string]any)
	if !ok {
		fields.Fail(path, "is not a map")
		return fields
	}
	fields.values = record
	return fields
}

func (fields *Fields) Err() error {
	return *fields.err
}

func (fields *Fields) Map() map[string]any {
	return fields.values
}

func (fields *Fields) at(key string) string {
	if fields.path == "" {
		return key
	}
	return fields.path + "." + key
}

func (fields *Fields) Fail(path string, reason string) {
	if *fields.err != nil {
		return
	}
	*fields.err = narsilerr.New(fields.code, "The "+fields.what+" holds "+quoted(path)+" that "+reason,
		map[string]any{"field": path})
}

func quoted(path string) string {
	if path == "" {
		return "a value"
	}
	return "\"" + path + "\""
}

func (fields *Fields) Has(key string) bool {
	_, ok := fields.values[key]
	return ok
}

func (fields *Fields) HasValue(key string) bool {
	value, ok := fields.values[key]
	return ok && value != nil
}

func (fields *Fields) Value(key string) any {
	return fields.values[key]
}

func (fields *Fields) Keys() []string {
	keys := make([]string, 0, len(fields.values))
	for key := range fields.values {
		keys = append(keys, key)
	}
	return keys
}

func (fields *Fields) String(key string) string {
	text, ok := fields.values[key].(string)
	if !ok {
		fields.Fail(fields.at(key), "is not a string")
	}
	return text
}

func (fields *Fields) Bool(key string) bool {
	flag, ok := fields.values[key].(bool)
	if !ok {
		fields.Fail(fields.at(key), "is not a boolean")
	}
	return flag
}

func (fields *Fields) Number(key string) float64 {
	number, ok := fields.values[key].(float64)
	if !ok {
		fields.Fail(fields.at(key), "is not a number")
	}
	return number
}

func (fields *Fields) Uint(key string, maximum uint64) uint64 {
	return fields.UintAt(fields.values[key], fields.at(key), maximum)
}

func (fields *Fields) UintAt(value any, path string, maximum uint64) uint64 {
	number, ok := value.(float64)
	if !ok || number < 0 || number != math.Trunc(number) || number > MaxSafeInteger || uint64(number) > maximum {
		fields.Fail(path, "is not an integer from 0 to "+strconv.FormatUint(min(maximum, MaxSafeInteger), 10))
		return 0
	}
	return uint64(number)
}

func (fields *Fields) List(key string) []any {
	list, ok := fields.values[key].([]any)
	if !ok {
		fields.Fail(fields.at(key), "is not a list")
	}
	return list
}

func (fields *Fields) Strings(key string) []string {
	list := fields.List(key)
	texts := make([]string, 0, len(list))
	for index, element := range list {
		text, ok := element.(string)
		if !ok {
			fields.Fail(fields.at(key)+"["+strconv.Itoa(index)+"]", "is not a string")
			return nil
		}
		texts = append(texts, text)
	}
	return texts
}

func (fields *Fields) Object(key string) *Fields {
	child := &Fields{path: fields.at(key), code: fields.code, what: fields.what, err: fields.err}
	record, ok := fields.values[key].(map[string]any)
	if !ok {
		fields.Fail(fields.at(key), "is not a map")
		return child
	}
	child.values = record
	return child
}

func (fields *Fields) Element(list []any, key string, index int) *Fields {
	path := fields.at(key) + "[" + strconv.Itoa(index) + "]"
	child := &Fields{path: path, code: fields.code, what: fields.what, err: fields.err}
	record, ok := list[index].(map[string]any)
	if !ok {
		fields.Fail(path, "is not a map")
		return child
	}
	child.values = record
	return child
}
