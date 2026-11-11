package keyword

import (
	"encoding/binary"
	"math"
)

const (
	Uint16Bytes  = 2
	Uint32Bytes  = 4
	Uint64Bytes  = 8
	Float64Bytes = 8
)

type Uint16s []byte

func (values Uint16s) Len() int {
	return len(values) / Uint16Bytes
}

func (values Uint16s) At(index int) uint16 {
	return binary.LittleEndian.Uint16(values[index*Uint16Bytes:])
}

type Uint32s []byte

func (values Uint32s) Len() int {
	return len(values) / Uint32Bytes
}

func (values Uint32s) At(index int) uint32 {
	return binary.LittleEndian.Uint32(values[index*Uint32Bytes:])
}

func (values Uint32s) Last() uint32 {
	return values.At(values.Len() - 1)
}

type Uint64s []byte

func (values Uint64s) Len() int {
	return len(values) / Uint64Bytes
}

func (values Uint64s) At(index int) uint64 {
	return binary.LittleEndian.Uint64(values[index*Uint64Bytes:])
}

type Float64s []byte

func (values Float64s) Len() int {
	return len(values) / Float64Bytes
}

func (values Float64s) At(index int) float64 {
	return math.Float64frombits(binary.LittleEndian.Uint64(values[index*Float64Bytes:]))
}

func Uint32sOf(values ...uint32) Uint32s {
	bytes := make([]byte, 0, len(values)*Uint32Bytes)
	for _, value := range values {
		bytes = binary.LittleEndian.AppendUint32(bytes, value)
	}
	return bytes
}

func entryOf(blob []byte, offsets Uint32s, index int) []byte {
	return blob[offsets.At(index):offsets.At(index+1)]
}
