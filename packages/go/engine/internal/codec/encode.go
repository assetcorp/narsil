package codec

import (
	"fmt"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Extension struct {
	Type int8
	Data []byte
}

type Raw []byte

type MapEntry struct {
	Key   string
	Value any
}

type OrderedMap []MapEntry

type InvalidDate struct{}

type EncodeOptions struct {
	ForceIntegerToFloat bool
	MaxDepth            int
	ErrorCode           string
}

type encoder struct {
	options  EncodeOptions
	maxDepth int
}

func newEncoder(options EncodeOptions) encoder {
	maxDepth := options.MaxDepth
	if maxDepth <= 0 {
		maxDepth = DefaultMaxEncodeDepth
	}
	if options.ErrorCode == "" {
		options.ErrorCode = narsilerr.CodeDocValidationFailed
	}
	return encoder{options: options, maxDepth: maxDepth}
}

func (state encoder) fail(format string, arguments ...any) error {
	return narsilerr.New(state.options.ErrorCode, fmt.Sprintf(format, arguments...), nil)
}

func Marshal(value any, options EncodeOptions) ([]byte, error) {
	return AppendValue(nil, value, options)
}

func AppendValue(destination []byte, value any, options EncodeOptions) ([]byte, error) {
	state := newEncoder(options)
	return state.appendValue(destination, value, 1)
}

func (state encoder) appendNumber(destination []byte, value float64) []byte {
	return AppendNumber(destination, value, state.options.ForceIntegerToFloat)
}

func (state encoder) requireLength(length int, kind string) error {
	if uint64(length) >= uint32Limit {
		return state.fail("Too large %s: %d", kind, length)
	}
	return nil
}

func (state encoder) appendValue(destination []byte, value any, depth int) ([]byte, error) {
	if depth > state.maxDepth {
		return destination, state.fail("Too deep objects in depth %d", depth)
	}
	switch typed := value.(type) {
	case nil:
		return AppendNil(destination), nil
	case bool:
		return AppendBool(destination, typed), nil
	case float64:
		return state.appendNumber(destination, typed), nil
	case string:
		if err := state.requireLength(len(typed), "string"); err != nil {
			return destination, err
		}
		return AppendString(destination, typed), nil
	case []any:
		return state.appendList(destination, typed, depth)
	case map[string]any:
		return state.appendMap(destination, typed, depth)
	case OrderedMap:
		return state.appendOrderedMap(destination, typed, depth)
	case time.Time:
		return AppendTimestamp(destination, typed), nil
	case InvalidDate:
		return AppendInvalidDate(destination), nil
	case []byte:
		if err := state.requireLength(len(typed), "binary"); err != nil {
			return destination, err
		}
		return AppendBinary(destination, typed), nil
	case []float32:
		if err := state.requireLength(len(typed)*4, "binary"); err != nil {
			return destination, err
		}
		return AppendFloat32Binary(destination, typed), nil
	case Extension:
		if err := state.requireLength(len(typed.Data), "extension object"); err != nil {
			return destination, err
		}
		return AppendExtension(destination, typed), nil
	case Raw:
		return append(destination, typed...), nil
	}
	return state.appendGoValue(destination, value, depth)
}

func (state encoder) appendGoValue(destination []byte, value any, depth int) ([]byte, error) {
	switch typed := value.(type) {
	case float32:
		return state.appendNumber(destination, float64(typed)), nil
	case int:
		return state.appendNumber(destination, float64(typed)), nil
	case int8:
		return state.appendNumber(destination, float64(typed)), nil
	case int16:
		return state.appendNumber(destination, float64(typed)), nil
	case int32:
		return state.appendNumber(destination, float64(typed)), nil
	case int64:
		return state.appendNumber(destination, float64(typed)), nil
	case uint:
		return state.appendNumber(destination, float64(typed)), nil
	case uint8:
		return state.appendNumber(destination, float64(typed)), nil
	case uint16:
		return state.appendNumber(destination, float64(typed)), nil
	case uint32:
		return state.appendNumber(destination, float64(typed)), nil
	case uint64:
		return state.appendNumber(destination, float64(typed)), nil
	case []string:
		if err := state.requireLength(len(typed), "array"); err != nil {
			return destination, err
		}
		destination = AppendArrayHeader(destination, len(typed))
		for _, element := range typed {
			if depth+1 > state.maxDepth {
				return destination, state.fail("Too deep objects in depth %d", depth+1)
			}
			destination = AppendString(destination, element)
		}
		return destination, nil
	case []float64:
		if err := state.requireLength(len(typed), "array"); err != nil {
			return destination, err
		}
		destination = AppendArrayHeader(destination, len(typed))
		for _, element := range typed {
			if depth+1 > state.maxDepth {
				return destination, state.fail("Too deep objects in depth %d", depth+1)
			}
			destination = state.appendNumber(destination, element)
		}
		return destination, nil
	case map[string]string:
		converted := make(map[string]any, len(typed))
		for key, element := range typed {
			converted[key] = element
		}
		return state.appendMap(destination, converted, depth)
	}
	return destination, state.fail("Unrecognized object: %T", value)
}

func (state encoder) appendList(destination []byte, list []any, depth int) ([]byte, error) {
	if err := state.requireLength(len(list), "array"); err != nil {
		return destination, err
	}
	destination = AppendArrayHeader(destination, len(list))
	var err error
	for _, element := range list {
		if destination, err = state.appendValue(destination, element, depth+1); err != nil {
			return destination, err
		}
	}
	return destination, nil
}

func (state encoder) appendMap(destination []byte, record map[string]any, depth int) ([]byte, error) {
	if err := state.requireLength(len(record), "map object"); err != nil {
		return destination, err
	}
	destination = AppendMapHeader(destination, len(record))
	var err error
	for _, key := range ObjectKeyOrder(record) {
		destination = AppendString(destination, key)
		if destination, err = state.appendValue(destination, record[key], depth+1); err != nil {
			return destination, err
		}
	}
	return destination, nil
}

func (state encoder) appendOrderedMap(destination []byte, record OrderedMap, depth int) ([]byte, error) {
	if err := state.requireLength(len(record), "map object"); err != nil {
		return destination, err
	}
	destination = AppendMapHeader(destination, len(record))
	var err error
	for _, entry := range record {
		destination = AppendString(destination, entry.Key)
		if destination, err = state.appendValue(destination, entry.Value, depth+1); err != nil {
			return destination, err
		}
	}
	return destination, nil
}
