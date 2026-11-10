package results

import (
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
)

const (
	groupShapeOneValue byte = 1
	groupShapeArray    byte = 2
)

const (
	groupKindNull byte = iota
	groupKindFalse
	groupKindTrue
	groupKindNumber
	groupKindString
	groupKindOther
	groupKindUnencodable
)

func appendLengthPrefixed(destination []byte, kind byte, content []byte) []byte {
	destination = append(destination, kind)
	destination = binary.AppendUvarint(destination, uint64(len(content)))
	return append(destination, content...)
}

func appendGroupNumber(destination []byte, value float64) []byte {
	if value == 0 {
		value = 0
	}
	if math.IsNaN(value) {
		value = math.NaN()
	}
	return binary.BigEndian.AppendUint64(append(destination, groupKindNumber), math.Float64bits(value))
}

func appendGroupElement(destination []byte, value any) []byte {
	switch typed := value.(type) {
	case nil:
		return append(destination, groupKindNull)
	case bool:
		if typed {
			return append(destination, groupKindTrue)
		}
		return append(destination, groupKindFalse)
	case float64:
		return appendGroupNumber(destination, typed)
	case string:
		return appendLengthPrefixed(destination, groupKindString, []byte(typed))
	}
	encoded, err := codec.Marshal(value, codec.EncodeOptions{})
	if err != nil {
		return append(destination, groupKindUnencodable)
	}
	return appendLengthPrefixed(destination, groupKindOther, encoded)
}

func appendGroupField(destination []byte, stored StoredValue) []byte {
	if !stored.Present {
		return append(destination, groupShapeOneValue, groupKindNull)
	}
	switch typed := stored.Value.(type) {
	case []any:
		destination = binary.AppendUvarint(append(destination, groupShapeArray), uint64(len(typed)))
		for _, element := range typed {
			destination = appendGroupElement(destination, element)
		}
		return destination
	case []float32:
		destination = binary.AppendUvarint(append(destination, groupShapeArray), uint64(len(typed)))
		for _, element := range typed {
			destination = appendGroupNumber(destination, float64(element))
		}
		return destination
	}
	return appendGroupElement(append(destination, groupShapeOneValue), stored.Value)
}

func groupKeyOf(values []StoredValue) string {
	var key []byte
	for _, stored := range values {
		key = appendGroupField(key, stored)
	}
	return string(key)
}
