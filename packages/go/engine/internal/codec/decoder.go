package codec

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ValueType uint8

const (
	TypeInvalid ValueType = iota
	TypeNil
	TypeBoolean
	TypeInteger
	TypeFloat
	TypeString
	TypeBinary
	TypeArray
	TypeMap
	TypeExtension
)

type DecodeOptions struct {
	ErrorCode   string
	ShareBinary bool
	MaxDepth    int
}

type Decoder struct {
	data        []byte
	position    int
	errorCode   string
	shareBinary bool
	maxDepth    int
	shared      string
}

func NewDecoder(data []byte, options DecodeOptions) *Decoder {
	decoder := &Decoder{data: data, errorCode: options.ErrorCode, shareBinary: options.ShareBinary, maxDepth: options.MaxDepth}
	if decoder.errorCode == "" {
		decoder.errorCode = narsilerr.CodePersistenceLoadFailed
	}
	if decoder.maxDepth <= 0 {
		decoder.maxDepth = DefaultMaxDecodeDepth
	}
	return decoder
}

func (decoder *Decoder) Position() int {
	return decoder.position
}

func (decoder *Decoder) Remaining() int {
	return len(decoder.data) - decoder.position
}

func (decoder *Decoder) More() bool {
	return decoder.position < len(decoder.data)
}

var ErrTruncated = errors.New("the MessagePack payload holds fewer bytes than it declares")

const decodingFailurePrefix = "MessagePack decoding failed: "

func (decoder *Decoder) failure(format string, arguments ...any) *narsilerr.Error {
	return narsilerr.New(
		decoder.errorCode,
		decodingFailurePrefix+fmt.Sprintf(format, arguments...),
		map[string]any{"offset": decoder.position},
	)
}

func (decoder *Decoder) Errorf(format string, arguments ...any) error {
	return decoder.failure(format, arguments...)
}

func (decoder *Decoder) insufficient() error {
	return decoder.failure("Insufficient data at buffer[%d] of %d byte(s)", decoder.position, len(decoder.data)).
		CausedBy(ErrTruncated)
}

func (decoder *Decoder) take(count int) ([]byte, error) {
	if count < 0 || count > decoder.Remaining() {
		return nil, decoder.insufficient()
	}
	start := decoder.position
	decoder.position += count
	return decoder.data[start:decoder.position:decoder.position], nil
}

func (decoder *Decoder) peekTag() (byte, error) {
	if decoder.position >= len(decoder.data) {
		return 0, decoder.insufficient()
	}
	return decoder.data[decoder.position], nil
}

func (decoder *Decoder) readTag() (byte, error) {
	tag, err := decoder.peekTag()
	if err == nil {
		decoder.position++
	}
	return tag, err
}

func (decoder *Decoder) readLength(byteCount int) (int, error) {
	bytes, err := decoder.take(byteCount)
	if err != nil {
		return 0, err
	}
	switch byteCount {
	case 1:
		return int(bytes[0]), nil
	case 2:
		return int(binary.BigEndian.Uint16(bytes)), nil
	}
	return int(binary.BigEndian.Uint32(bytes)), nil
}

func typeOfTag(tag byte) ValueType {
	switch {
	case tag <= tagPositiveFixintLast || tag >= tagNegativeFixint:
		return TypeInteger
	case tag <= tagFixmapLast:
		return TypeMap
	case tag <= tagFixarrayLast:
		return TypeArray
	case tag <= tagFixstrLast:
		return TypeString
	}
	switch tag {
	case tagNil:
		return TypeNil
	case tagFalse, tagTrue:
		return TypeBoolean
	case tagBin8, tagBin16, tagBin32:
		return TypeBinary
	case tagExt8, tagExt16, tagExt32, tagFixext1, tagFixext2, tagFixext4, tagFixext8, tagFixext16:
		return TypeExtension
	case tagFloat32, tagFloat64:
		return TypeFloat
	case tagUint8, tagUint16, tagUint32, tagUint64, tagInt8, tagInt16, tagInt32, tagInt64:
		return TypeInteger
	case tagStr8, tagStr16, tagStr32:
		return TypeString
	case tagArray16, tagArray32:
		return TypeArray
	case tagMap16, tagMap32:
		return TypeMap
	}
	return TypeInvalid
}

func (decoder *Decoder) unexpected(tag byte, wanted string) error {
	if typeOfTag(tag) == TypeInvalid {
		return decoder.Errorf("Unrecognized type byte: 0x%02x", tag)
	}
	return decoder.Errorf("expected %s but found type byte 0x%02x", wanted, tag)
}

func (decoder *Decoder) TryReadNil() bool {
	if decoder.position < len(decoder.data) && decoder.data[decoder.position] == tagNil {
		decoder.position++
		return true
	}
	return false
}

func (decoder *Decoder) readNumberAfterTag(tag byte) (float64, bool, error) {
	if tag <= tagPositiveFixintLast {
		return float64(tag), true, nil
	}
	if tag >= tagNegativeFixint {
		return float64(int(tag) - 0x100), true, nil
	}
	width := numberWidth(tag)
	if width == 0 {
		return 0, false, nil
	}
	bytes, err := decoder.take(width)
	if err != nil {
		return 0, true, err
	}
	switch tag {
	case tagFloat32:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(bytes))), true, nil
	case tagFloat64:
		return math.Float64frombits(binary.BigEndian.Uint64(bytes)), true, nil
	case tagUint8:
		return float64(bytes[0]), true, nil
	case tagUint16:
		return float64(binary.BigEndian.Uint16(bytes)), true, nil
	case tagUint32:
		return float64(binary.BigEndian.Uint32(bytes)), true, nil
	case tagUint64:
		return float64(binary.BigEndian.Uint64(bytes)), true, nil
	case tagInt8:
		return float64(int8(bytes[0])), true, nil
	case tagInt16:
		return float64(int16(binary.BigEndian.Uint16(bytes))), true, nil
	case tagInt32:
		return float64(int32(binary.BigEndian.Uint32(bytes))), true, nil
	}
	return float64(int64(binary.BigEndian.Uint64(bytes))), true, nil
}

func numberWidth(tag byte) int {
	switch tag {
	case tagUint8, tagInt8:
		return 1
	case tagUint16, tagInt16:
		return 2
	case tagFloat32, tagUint32, tagInt32:
		return 4
	case tagFloat64, tagUint64, tagInt64:
		return 8
	}
	return 0
}

func (decoder *Decoder) ReadNumber() (float64, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	number, isNumber, err := decoder.readNumberAfterTag(tag)
	if !isNumber {
		decoder.position--
		return 0, decoder.unexpected(tag, "a number")
	}
	return number, err
}

func (decoder *Decoder) ReadUnsigned() (uint64, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	if tag <= tagPositiveFixintLast {
		return uint64(tag), nil
	}
	if tag < tagUint8 || tag > tagUint64 {
		decoder.position--
		return 0, decoder.unexpected(tag, "an unsigned integer")
	}
	bytes, err := decoder.take(numberWidth(tag))
	if err != nil {
		return 0, err
	}
	var value uint64
	for _, part := range bytes {
		value = value<<8 | uint64(part)
	}
	return value, nil
}

func (decoder *Decoder) stringLengthAfterTag(tag byte) (int, bool, error) {
	if tag >= tagFixstr && tag <= tagFixstrLast {
		return int(tag - tagFixstr), true, nil
	}
	switch tag {
	case tagStr8:
		length, err := decoder.readLength(1)
		return length, true, err
	case tagStr16:
		length, err := decoder.readLength(2)
		return length, true, err
	case tagStr32:
		length, err := decoder.readLength(4)
		return length, true, err
	}
	return 0, false, nil
}

func (decoder *Decoder) ReadStringBytes() ([]byte, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return nil, err
	}
	length, isString, err := decoder.stringLengthAfterTag(tag)
	if !isString {
		decoder.position--
		return nil, decoder.unexpected(tag, "a string")
	}
	if err != nil {
		return nil, err
	}
	return decoder.take(length)
}

func (decoder *Decoder) ReadString() (string, error) {
	bytes, err := decoder.ReadStringBytes()
	if err != nil {
		return "", err
	}
	return text.DecodeUTF8(bytes), nil
}

func (decoder *Decoder) binaryLengthAfterTag(tag byte) (int, bool, error) {
	switch tag {
	case tagBin8:
		length, err := decoder.readLength(1)
		return length, true, err
	case tagBin16:
		length, err := decoder.readLength(2)
		return length, true, err
	case tagBin32:
		length, err := decoder.readLength(4)
		return length, true, err
	}
	return 0, false, nil
}

func (decoder *Decoder) ownedBytes(bytes []byte) []byte {
	if decoder.shareBinary {
		return bytes
	}
	return append([]byte{}, bytes...)
}

func (decoder *Decoder) ReadBinary() ([]byte, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return nil, err
	}
	length, isBinary, err := decoder.binaryLengthAfterTag(tag)
	if !isBinary {
		decoder.position--
		return nil, decoder.unexpected(tag, "binary data")
	}
	if err != nil {
		return nil, err
	}
	bytes, err := decoder.take(length)
	if err != nil {
		return nil, err
	}
	return decoder.ownedBytes(bytes), nil
}
