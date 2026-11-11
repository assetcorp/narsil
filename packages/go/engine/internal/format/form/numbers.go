package form

import (
	"encoding/binary"
	"math"
	"strconv"
)

type Width uint8

const (
	WidthUint8 Width = iota
	WidthUint16
	WidthUint32
	WidthUint64
	WidthFloat32
	WidthFloat64
)

func (width Width) Bytes() int {
	switch width {
	case WidthUint8:
		return 1
	case WidthUint16:
		return 2
	case WidthUint32, WidthFloat32:
		return 4
	default:
		return 8
	}
}

func (width Width) maximum() uint64 {
	switch width {
	case WidthUint8:
		return math.MaxUint8
	case WidthUint16:
		return math.MaxUint16
	case WidthUint32:
		return math.MaxUint32
	default:
		return MaxSafeInteger
	}
}

func Values(data []byte, width Width) []float64 {
	size := width.Bytes()
	values := make([]float64, len(data)/size)
	for index := range values {
		at := data[index*size:]
		switch width {
		case WidthUint8:
			values[index] = float64(at[0])
		case WidthUint16:
			values[index] = float64(binary.LittleEndian.Uint16(at))
		case WidthUint32:
			values[index] = float64(binary.LittleEndian.Uint32(at))
		case WidthUint64:
			values[index] = float64(binary.LittleEndian.Uint64(at))
		case WidthFloat32:
			values[index] = float64(math.Float32frombits(binary.LittleEndian.Uint32(at)))
		case WidthFloat64:
			values[index] = math.Float64frombits(binary.LittleEndian.Uint64(at))
		}
	}
	return values
}

func (fields *Fields) NumberBytes(key string, width Width) []byte {
	return fields.NumberBytesAt(fields.values[key], fields.at(key), width)
}

func (fields *Fields) NumberBytesAt(value any, path string, width Width) []byte {
	list, ok := value.([]any)
	if !ok {
		fields.Fail(path, "is not a list of numbers")
		return nil
	}
	size := width.Bytes()
	data := make([]byte, len(list)*size)
	for index, element := range list {
		number, isNumber := element.(float64)
		if !isNumber {
			fields.Fail(path+"["+strconv.Itoa(index)+"]", "is not a number")
			return nil
		}
		at := data[index*size:]
		switch width {
		case WidthFloat32:
			binary.LittleEndian.PutUint32(at, math.Float32bits(float32(number)))
			continue
		case WidthFloat64:
			binary.LittleEndian.PutUint64(at, math.Float64bits(number))
			continue
		}
		integer := fields.UintAt(number, path+"["+strconv.Itoa(index)+"]", width.maximum())
		switch width {
		case WidthUint8:
			at[0] = byte(integer)
		case WidthUint16:
			binary.LittleEndian.PutUint16(at, uint16(integer))
		case WidthUint32:
			binary.LittleEndian.PutUint32(at, uint32(integer))
		default:
			binary.LittleEndian.PutUint64(at, integer)
		}
	}
	return data
}

func StringValues(texts []string) []any {
	values := make([]any, len(texts))
	for index, text := range texts {
		values[index] = text
	}
	return values
}
