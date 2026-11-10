package codec

import (
	"encoding/binary"
	"math"
)

const (
	tagPositiveFixintLast = 0x7f
	tagFixmap             = 0x80
	tagFixmapLast         = 0x8f
	tagFixarray           = 0x90
	tagFixarrayLast       = 0x9f
	tagFixstr             = 0xa0
	tagFixstrLast         = 0xbf
	tagNil                = 0xc0
	tagNeverUsed          = 0xc1
	tagFalse              = 0xc2
	tagTrue               = 0xc3
	tagBin8               = 0xc4
	tagBin16              = 0xc5
	tagBin32              = 0xc6
	tagExt8               = 0xc7
	tagExt16              = 0xc8
	tagExt32              = 0xc9
	tagFloat32            = 0xca
	tagFloat64            = 0xcb
	tagUint8              = 0xcc
	tagUint16             = 0xcd
	tagUint32             = 0xce
	tagUint64             = 0xcf
	tagInt8               = 0xd0
	tagInt16              = 0xd1
	tagInt32              = 0xd2
	tagInt64              = 0xd3
	tagFixext1            = 0xd4
	tagFixext2            = 0xd5
	tagFixext4            = 0xd6
	tagFixext8            = 0xd7
	tagFixext16           = 0xd8
	tagStr8               = 0xd9
	tagStr16              = 0xda
	tagStr32              = 0xdb
	tagArray16            = 0xdc
	tagArray32            = 0xdd
	tagMap16              = 0xde
	tagMap32              = 0xdf
	tagNegativeFixint     = 0xe0

	fixCountLimit     = 16
	fixstrLengthLimit = 32
	uint8Limit        = 0x100
	uint16Limit       = 0x10000
	uint32Limit       = 0x100000000
	negativeFixintMin = -0x20
	int8Min           = -0x80
	int16Min          = -0x8000
	int32Min          = -0x80000000
)

func appendUint16(destination []byte, value uint16) []byte {
	return binary.BigEndian.AppendUint16(destination, value)
}

func appendUint32(destination []byte, value uint32) []byte {
	return binary.BigEndian.AppendUint32(destination, value)
}

func appendUint64(destination []byte, value uint64) []byte {
	return binary.BigEndian.AppendUint64(destination, value)
}

func appendCountHeader(destination []byte, fixed byte, sixteen byte, thirtyTwo byte, count int) []byte {
	switch {
	case count < fixCountLimit:
		return append(destination, fixed|byte(count))
	case count < uint16Limit:
		return appendUint16(append(destination, sixteen), uint16(count))
	}
	return appendUint32(append(destination, thirtyTwo), uint32(count))
}

func AppendArrayHeader(destination []byte, count int) []byte {
	return appendCountHeader(destination, tagFixarray, tagArray16, tagArray32, count)
}

func AppendMapHeader(destination []byte, count int) []byte {
	return appendCountHeader(destination, tagFixmap, tagMap16, tagMap32, count)
}

func AppendNil(destination []byte) []byte {
	return append(destination, tagNil)
}

func AppendBool(destination []byte, value bool) []byte {
	if value {
		return append(destination, tagTrue)
	}
	return append(destination, tagFalse)
}

func AppendStringHeader(destination []byte, byteLength int) []byte {
	switch {
	case byteLength < fixstrLengthLimit:
		return append(destination, tagFixstr+byte(byteLength))
	case byteLength < uint8Limit:
		return append(destination, tagStr8, byte(byteLength))
	case byteLength < uint16Limit:
		return appendUint16(append(destination, tagStr16), uint16(byteLength))
	}
	return appendUint32(append(destination, tagStr32), uint32(byteLength))
}

func AppendString(destination []byte, value string) []byte {
	return append(AppendStringHeader(destination, len(value)), value...)
}

func AppendBinaryHeader(destination []byte, byteLength int) []byte {
	switch {
	case byteLength < uint8Limit:
		return append(destination, tagBin8, byte(byteLength))
	case byteLength < uint16Limit:
		return appendUint16(append(destination, tagBin16), uint16(byteLength))
	}
	return appendUint32(append(destination, tagBin32), uint32(byteLength))
}

func AppendBinary(destination []byte, value []byte) []byte {
	return append(AppendBinaryHeader(destination, len(value)), value...)
}

func AppendFloat32Binary(destination []byte, values []float32) []byte {
	destination = AppendBinaryHeader(destination, len(values)*4)
	for _, value := range values {
		destination = binary.LittleEndian.AppendUint32(destination, math.Float32bits(value))
	}
	return destination
}

func AppendExtension(destination []byte, extension Extension) []byte {
	size := len(extension.Data)
	switch size {
	case 1:
		destination = append(destination, tagFixext1)
	case 2:
		destination = append(destination, tagFixext2)
	case 4:
		destination = append(destination, tagFixext4)
	case 8:
		destination = append(destination, tagFixext8)
	case 16:
		destination = append(destination, tagFixext16)
	default:
		switch {
		case size < uint8Limit:
			destination = append(destination, tagExt8, byte(size))
		case size < uint16Limit:
			destination = appendUint16(append(destination, tagExt16), uint16(size))
		default:
			destination = appendUint32(append(destination, tagExt32), uint32(size))
		}
	}
	destination = append(destination, byte(extension.Type))
	return append(destination, extension.Data...)
}

const javaScriptNaNBits uint64 = 0x7FF8000000000000

func JavaScriptNaN() float64 {
	return math.Float64frombits(javaScriptNaNBits)
}

func AppendFloat64(destination []byte, value float64) []byte {
	return appendUint64(append(destination, tagFloat64), math.Float64bits(value))
}

func isSafeInteger(value float64) bool {
	return value == math.Trunc(value) && math.Abs(value) <= maxSafeInteger
}

func AppendNumber(destination []byte, value float64, forceIntegerToFloat bool) []byte {
	if forceIntegerToFloat || !isSafeInteger(value) {
		return AppendFloat64(destination, value)
	}
	if value >= 0 {
		unsigned := uint64(value)
		switch {
		case unsigned <= tagPositiveFixintLast:
			return append(destination, byte(unsigned))
		case unsigned < uint8Limit:
			return append(destination, tagUint8, byte(unsigned))
		case unsigned < uint16Limit:
			return appendUint16(append(destination, tagUint16), uint16(unsigned))
		case unsigned < uint32Limit:
			return appendUint32(append(destination, tagUint32), uint32(unsigned))
		}
		return appendUint64(append(destination, tagUint64), unsigned)
	}
	signed := int64(value)
	switch {
	case signed >= negativeFixintMin:
		return append(destination, byte(tagNegativeFixint|(signed-negativeFixintMin)))
	case signed >= int8Min:
		return append(destination, tagInt8, byte(int8(signed)))
	case signed >= int16Min:
		return appendUint16(append(destination, tagInt16), uint16(int16(signed)))
	case signed >= int32Min:
		return appendUint32(append(destination, tagInt32), uint32(int32(signed)))
	}
	return appendUint64(append(destination, tagInt64), uint64(signed))
}
