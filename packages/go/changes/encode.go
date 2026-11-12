package changes

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
)

const maxEncodeDepth = maxDocumentDepth

type encoder struct {
	out []byte
}

func encodeMessage(message map[string]any) ([]byte, error) {
	writer := &encoder{}
	if err := writer.value(message, 0); err != nil {
		return nil, err
	}
	return writer.out, nil
}

func (e *encoder) header(small byte, smallLimit int, wide16, wide32 byte, count int) {
	switch {
	case count < smallLimit:
		e.out = append(e.out, small|byte(count))
	case count <= math.MaxUint16:
		e.out = append(e.out, wide16)
		e.out = binary.BigEndian.AppendUint16(e.out, uint16(count))
	default:
		e.out = append(e.out, wide32)
		e.out = binary.BigEndian.AppendUint32(e.out, uint32(count))
	}
}

func (e *encoder) unsigned(value uint64) {
	switch {
	case value <= positiveFixintLastByte:
		e.out = append(e.out, byte(value))
	case value <= math.MaxUint8:
		e.out = append(e.out, 0xcc, byte(value))
	case value <= math.MaxUint16:
		e.out = binary.BigEndian.AppendUint16(append(e.out, 0xcd), uint16(value))
	case value <= math.MaxUint32:
		e.out = binary.BigEndian.AppendUint32(append(e.out, 0xce), uint32(value))
	default:
		e.out = binary.BigEndian.AppendUint64(append(e.out, 0xcf), value)
	}
}

func (e *encoder) signed(value int64) {
	if value >= 0 {
		e.unsigned(uint64(value))
		return
	}
	if value >= -32 {
		e.out = append(e.out, byte(value))
		return
	}
	e.out = binary.BigEndian.AppendUint64(append(e.out, 0xd3), uint64(value))
}

func (e *encoder) text(value string) {
	e.header(fixstrFirstByte, fixstrLengthMask+1, 0xda, 0xdb, len(value))
	e.out = append(e.out, value...)
}

func (e *encoder) float(value float64) {
	e.out = binary.BigEndian.AppendUint64(append(e.out, 0xcb), math.Float64bits(value))
}

func (e *encoder) number(value json.Number) error {
	if integer, err := value.Int64(); err == nil {
		e.signed(integer)
		return nil
	}
	float, err := value.Float64()
	if err != nil {
		return fmt.Errorf("the number %q has no MessagePack form", value.String())
	}
	e.float(float)
	return nil
}

func (e *encoder) value(value any, depth int) error {
	if depth > maxEncodeDepth {
		return fmt.Errorf("the message nests deeper than %d levels", maxEncodeDepth)
	}
	switch typed := value.(type) {
	case nil:
		e.out = append(e.out, 0xc0)
	case bool:
		if typed {
			e.out = append(e.out, 0xc3)
		} else {
			e.out = append(e.out, 0xc2)
		}
	case string:
		e.text(typed)
	case uint32:
		e.unsigned(uint64(typed))
	case uint64:
		e.unsigned(typed)
	case int64:
		e.signed(typed)
	case float64:
		e.float(typed)
	case json.Number:
		return e.number(typed)
	case []any:
		e.header(fixarrayFirstByte, fixLengthMask+1, 0xdc, 0xdd, len(typed))
		for _, item := range typed {
			if err := e.value(item, depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		e.header(fixmapFirstByte, fixLengthMask+1, 0xde, 0xdf, len(typed))
		for _, key := range slices.Sorted(maps.Keys(typed)) {
			e.text(key)
			if err := e.value(typed[key], depth+1); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("the value of type %T has no MessagePack form", value)
	}
	return nil
}
