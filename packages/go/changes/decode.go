package changes

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"
)

const (
	maxDocumentDepth         = 64
	messageEnvelopeDepth     = 3
	maxDecodeDepth           = maxDocumentDepth + messageEnvelopeDepth
	float32Bytes             = 4
	timestampExtensionType   = -1
	maxPreallocatedItems     = 1024
	nanosecondsPerSecond     = 1_000_000_000
	timestamp64SecondsBits   = 34
	timestamp64SecondsMask   = 1<<timestamp64SecondsBits - 1
	timestamp32Bytes         = 4
	timestamp64Bytes         = 8
	timestamp96Bytes         = 12
	negativeFixintFirstByte  = 0xe0
	positiveFixintLastByte   = 0x7f
	fixmapFirstByte          = 0x80
	fixarrayFirstByte        = 0x90
	fixstrFirstByte          = 0xa0
	fixLengthMask            = 0x0f
	fixstrLengthMask         = 0x1f
	fixextOneLengthFirstByte = 0xd4
)

// Extension holds a MessagePack extension value of a type that the subscriber does not convert, as a
// document can hold one.
type Extension struct {
	// Type is the extension type, from -128 to 127.
	Type int8
	// Data holds the bytes of the value.
	Data []byte
}

var errTruncated = errors.New("the message ends inside a value")

type decoder struct {
	data []byte
	at   int
}

func decodeMessage(data []byte) (any, error) {
	reader := &decoder{data: data}
	value, err := reader.value(0)
	if err != nil {
		return nil, err
	}
	if reader.at != len(data) {
		return nil, errors.New("the message holds bytes after its value")
	}
	return value, nil
}

func (d *decoder) remaining() int {
	return len(d.data) - d.at
}

func (d *decoder) take(count int) ([]byte, error) {
	if count < 0 || count > d.remaining() {
		return nil, errTruncated
	}
	chunk := d.data[d.at : d.at+count]
	d.at += count
	return chunk, nil
}

func (d *decoder) unsigned(width int) (uint64, error) {
	chunk, err := d.take(width)
	if err != nil {
		return 0, err
	}
	switch width {
	case 1:
		return uint64(chunk[0]), nil
	case 2:
		return uint64(binary.BigEndian.Uint16(chunk)), nil
	case 4:
		return uint64(binary.BigEndian.Uint32(chunk)), nil
	default:
		return binary.BigEndian.Uint64(chunk), nil
	}
}

func (d *decoder) length(width int) (int, error) {
	value, err := d.unsigned(width)
	if err != nil {
		return 0, err
	}
	if value > uint64(d.remaining()) {
		return 0, errTruncated
	}
	return int(value), nil
}

func integerOf(value uint64) any {
	if value <= math.MaxInt64 {
		return int64(value)
	}
	return value
}

func (d *decoder) signed(width int) (any, error) {
	value, err := d.unsigned(width)
	if err != nil {
		return nil, err
	}
	switch width {
	case 1:
		return int64(int8(value)), nil
	case 2:
		return int64(int16(value)), nil
	case 4:
		return int64(int32(value)), nil
	default:
		return int64(value), nil
	}
}

func (d *decoder) value(depth int) (any, error) {
	if depth > maxDecodeDepth {
		return nil, errors.New("a value nests too deeply")
	}
	head, err := d.take(1)
	if err != nil {
		return nil, err
	}
	tag := head[0]
	switch {
	case tag <= positiveFixintLastByte:
		return int64(tag), nil
	case tag >= negativeFixintFirstByte:
		return int64(int8(tag)), nil
	case tag < fixarrayFirstByte:
		return d.mapOf(int(tag&fixLengthMask), depth)
	case tag < fixstrFirstByte:
		return d.arrayOf(int(tag&fixLengthMask), depth)
	case tag < 0xc0:
		return d.stringOf(int(tag & fixstrLengthMask))
	}
	return d.tagged(tag, depth)
}

func (d *decoder) tagged(tag byte, depth int) (any, error) {
	switch tag {
	case 0xc0:
		return nil, nil
	case 0xc2:
		return false, nil
	case 0xc3:
		return true, nil
	case 0xc4, 0xc5, 0xc6:
		return d.withLength(1<<(tag-0xc4), d.vectorOf)
	case 0xc7, 0xc8, 0xc9:
		size, err := d.length(1 << (tag - 0xc7))
		if err != nil {
			return nil, err
		}
		return d.extensionOf(size)
	case 0xca:
		bits, err := d.unsigned(4)
		return float64(math.Float32frombits(uint32(bits))), err
	case 0xcb:
		bits, err := d.unsigned(8)
		return math.Float64frombits(bits), err
	case 0xcc, 0xcd, 0xce, 0xcf:
		value, err := d.unsigned(1 << (tag - 0xcc))
		return integerOf(value), err
	case 0xd0, 0xd1, 0xd2, 0xd3:
		return d.signed(1 << (tag - 0xd0))
	case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8:
		return d.extensionOf(1 << (tag - fixextOneLengthFirstByte))
	case 0xd9, 0xda, 0xdb:
		return d.withLength(1<<(tag-0xd9), d.stringOf)
	case 0xdc, 0xdd:
		count, err := d.unsigned(2 << (tag - 0xdc))
		if err != nil {
			return nil, err
		}
		return d.arrayOf(boundedCount(count), depth)
	case 0xde, 0xdf:
		count, err := d.unsigned(2 << (tag - 0xde))
		if err != nil {
			return nil, err
		}
		return d.mapOf(boundedCount(count), depth)
	}
	return nil, fmt.Errorf("the byte 0x%02x starts no MessagePack value", tag)
}

func boundedCount(count uint64) int {
	if count > math.MaxInt32 {
		return math.MaxInt32
	}
	return int(count)
}

func (d *decoder) withLength(width int, read func(int) (any, error)) (any, error) {
	size, err := d.length(width)
	if err != nil {
		return nil, err
	}
	return read(size)
}

func (d *decoder) stringOf(size int) (any, error) {
	chunk, err := d.take(size)
	if err != nil {
		return nil, err
	}
	return string(chunk), nil
}

func (d *decoder) vectorOf(size int) (any, error) {
	chunk, err := d.take(size)
	if err != nil {
		return nil, err
	}
	if size%float32Bytes != 0 {
		return nil, errors.New("a vector has a length that is not whole floats")
	}
	vector := make([]float32, size/float32Bytes)
	for at := range vector {
		vector[at] = math.Float32frombits(binary.LittleEndian.Uint32(chunk[at*float32Bytes:]))
	}
	return vector, nil
}

func (d *decoder) extensionOf(size int) (any, error) {
	kind, err := d.take(1)
	if err != nil {
		return nil, err
	}
	data, err := d.take(size)
	if err != nil {
		return nil, err
	}
	if int8(kind[0]) != timestampExtensionType {
		return Extension{Type: int8(kind[0]), Data: append([]byte(nil), data...)}, nil
	}
	return timestampOf(data)
}

func timestampOf(data []byte) (any, error) {
	var seconds int64
	var nanoseconds uint64
	switch len(data) {
	case timestamp32Bytes:
		seconds = int64(binary.BigEndian.Uint32(data))
	case timestamp64Bytes:
		packed := binary.BigEndian.Uint64(data)
		nanoseconds = packed >> timestamp64SecondsBits
		seconds = int64(packed & timestamp64SecondsMask)
	case timestamp96Bytes:
		nanoseconds = uint64(binary.BigEndian.Uint32(data))
		seconds = int64(binary.BigEndian.Uint64(data[timestamp32Bytes:]))
	default:
		return nil, errors.New("a timestamp has a length that MessagePack does not define")
	}
	if nanoseconds >= nanosecondsPerSecond {
		return nil, errors.New("a timestamp holds more than a second of nanoseconds")
	}
	return time.Unix(seconds, int64(nanoseconds)).UTC(), nil
}

func (d *decoder) arrayOf(count, depth int) (any, error) {
	if count > d.remaining() {
		return nil, errTruncated
	}
	items := make([]any, 0, min(count, maxPreallocatedItems))
	for range count {
		item, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (d *decoder) mapOf(count, depth int) (any, error) {
	if count > d.remaining()/2 {
		return nil, errTruncated
	}
	entries := make(map[string]any, min(count, maxPreallocatedItems))
	for range count {
		key, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, errors.New("a map has a key that is not a string")
		}
		item, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		entries[name] = item
	}
	return entries, nil
}
