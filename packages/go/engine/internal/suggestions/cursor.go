package suggestions

import (
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

var errMalformed = errors.New("malformed payload")

type malformed struct{ reason string }

func (problem malformed) Error() string { return problem.reason }

func (problem malformed) Unwrap() error { return errMalformed }

func fail(reason string) error { return malformed{reason: reason} }

type writer struct{ bytes []byte }

func (out *writer) container(length int, fix, sixteen, thirtyTwo byte) {
	switch {
	case length <= 15:
		out.bytes = append(out.bytes, fix|byte(length))
	case length <= 0xffff:
		out.bytes = binary.BigEndian.AppendUint16(append(out.bytes, sixteen), uint16(length))
	default:
		out.bytes = binary.BigEndian.AppendUint32(append(out.bytes, thirtyTwo), uint32(length))
	}
}

func (out *writer) mapHeader(length int) { out.container(length, 0x80, 0xde, 0xdf) }

func (out *writer) arrayHeader(length int) { out.container(length, 0x90, 0xdc, 0xdd) }

func (out *writer) text(value string) {
	length := len(value)
	switch {
	case length <= 31:
		out.bytes = append(out.bytes, 0xa0|byte(length))
	case length <= 0xff:
		out.bytes = append(out.bytes, 0xd9, byte(length))
	case length <= 0xffff:
		out.bytes = binary.BigEndian.AppendUint16(append(out.bytes, 0xda), uint16(length))
	default:
		out.bytes = binary.BigEndian.AppendUint32(append(out.bytes, 0xdb), uint32(length))
	}
	out.bytes = append(out.bytes, value...)
}

func (out *writer) binary(value []byte) {
	length := len(value)
	switch {
	case length <= 0xff:
		out.bytes = append(out.bytes, 0xc4, byte(length))
	case length <= 0xffff:
		out.bytes = binary.BigEndian.AppendUint16(append(out.bytes, 0xc5), uint16(length))
	default:
		out.bytes = binary.BigEndian.AppendUint32(append(out.bytes, 0xc6), uint32(length))
	}
	out.bytes = append(out.bytes, value...)
}

func (out *writer) uint(value uint64) {
	switch {
	case value < 0x80:
		out.bytes = append(out.bytes, byte(value))
	case value <= 0xff:
		out.bytes = append(out.bytes, 0xcc, byte(value))
	case value <= 0xffff:
		out.bytes = binary.BigEndian.AppendUint16(append(out.bytes, 0xcd), uint16(value))
	case value <= 0xffff_ffff:
		out.bytes = binary.BigEndian.AppendUint32(append(out.bytes, 0xce), uint32(value))
	default:
		out.bytes = binary.BigEndian.AppendUint64(append(out.bytes, 0xcf), value)
	}
}

type reader struct {
	bytes    []byte
	position int
}

const maxSafeInteger = 1<<53 - 1

func (in *reader) atEnd() bool { return in.position == len(in.bytes) }

func (in *reader) take(length int) ([]byte, error) {
	if length < 0 || length > len(in.bytes)-in.position {
		return nil, fail("The payload ends early")
	}
	start := in.position
	in.position += length
	return in.bytes[start:in.position], nil
}

func (in *reader) byte() (byte, error) {
	taken, err := in.take(1)
	if err != nil {
		return 0, err
	}
	return taken[0], nil
}

func (in *reader) length(width int) (int, error) {
	taken, err := in.take(width)
	if err != nil {
		return 0, err
	}
	switch width {
	case 1:
		return int(taken[0]), nil
	case 2:
		return int(binary.BigEndian.Uint16(taken)), nil
	}
	return int(binary.BigEndian.Uint32(taken)), nil
}

func (in *reader) container(fix, sixteen, thirtyTwo byte, what string) (int, error) {
	tag, err := in.byte()
	if err != nil {
		return 0, err
	}
	switch {
	case tag&0xf0 == fix:
		return int(tag & 0x0f), nil
	case tag == sixteen:
		return in.length(2)
	case tag == thirtyTwo:
		return in.length(4)
	}
	return 0, fail("Expected " + what)
}

func (in *reader) mapHeader() (int, error) { return in.container(0x80, 0xde, 0xdf, "a map") }

func (in *reader) arrayHeader() (int, error) { return in.container(0x90, 0xdc, 0xdd, "an array") }

func (in *reader) text() (string, error) {
	tag, err := in.byte()
	if err != nil {
		return "", err
	}
	var length int
	switch {
	case tag&0xe0 == 0xa0:
		length = int(tag & 0x1f)
	case tag == 0xd9:
		length, err = in.length(1)
	case tag == 0xda:
		length, err = in.length(2)
	case tag == 0xdb:
		length, err = in.length(4)
	default:
		return "", fail("Expected a string")
	}
	if err != nil {
		return "", err
	}
	taken, err := in.take(length)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(taken) {
		return "", fail("A string holds invalid UTF-8")
	}
	return string(taken), nil
}

func (in *reader) binary() ([]byte, error) {
	tag, err := in.byte()
	if err != nil {
		return nil, err
	}
	var length int
	switch tag {
	case 0xc4:
		length, err = in.length(1)
	case 0xc5:
		length, err = in.length(2)
	case 0xc6:
		length, err = in.length(4)
	default:
		return nil, fail("Expected bytes")
	}
	if err != nil {
		return nil, err
	}
	return in.take(length)
}

func (in *reader) uint() (uint64, error) {
	tag, err := in.byte()
	if err != nil {
		return 0, err
	}
	if tag < 0x80 {
		return uint64(tag), nil
	}
	if tag < 0xcc || tag > 0xcf {
		return 0, fail("Expected an unsigned integer")
	}
	width := 1 << (tag - 0xcc)
	taken, err := in.take(width)
	if err != nil {
		return 0, err
	}
	var value uint64
	for _, part := range taken {
		value = value<<8 | uint64(part)
	}
	if value > maxSafeInteger {
		return 0, fail("An integer is out of range")
	}
	return value, nil
}
