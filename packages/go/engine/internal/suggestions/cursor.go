package suggestions

import (
	"errors"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
)

var errMalformed = errors.New("malformed payload")

type malformed struct{ reason string }

func (problem malformed) Error() string { return problem.reason }

func (problem malformed) Unwrap() error { return errMalformed }

func fail(reason string) error { return malformed{reason: reason} }

type writer struct{ bytes []byte }

func (out *writer) mapHeader(length int) { out.bytes = codec.AppendMapHeader(out.bytes, length) }

func (out *writer) arrayHeader(length int) { out.bytes = codec.AppendArrayHeader(out.bytes, length) }

func (out *writer) text(value string) { out.bytes = codec.AppendString(out.bytes, value) }

func (out *writer) binary(value []byte) { out.bytes = codec.AppendBinary(out.bytes, value) }

func (out *writer) uint(value uint64) { out.bytes = codec.AppendUnsigned(out.bytes, value) }

type reader struct{ decoder *codec.Decoder }

const maxSafeInteger = 1<<53 - 1

func newReader(payload []byte) *reader {
	return &reader{decoder: codec.NewDecoder(payload, codec.DecodeOptions{ShareBinary: true})}
}

func unreadable(err error, expected string) error {
	if errors.Is(err, codec.ErrTruncated) {
		return fail("The payload ends early")
	}
	return fail("Expected " + expected)
}

func (in *reader) position() int { return in.decoder.Position() }

func (in *reader) atEnd() bool { return !in.decoder.More() }

func (in *reader) mapHeader() (int, error) {
	count, err := in.decoder.ReadMapCount()
	if err != nil {
		return 0, unreadable(err, "a map")
	}
	return count, nil
}

func (in *reader) arrayHeader() (int, error) {
	count, err := in.decoder.ReadArrayCount()
	if err != nil {
		return 0, unreadable(err, "an array")
	}
	return count, nil
}

func (in *reader) text() (string, error) {
	taken, err := in.decoder.ReadStringBytes()
	if err != nil {
		return "", unreadable(err, "a string")
	}
	if !utf8.Valid(taken) {
		return "", fail("A string holds invalid UTF-8")
	}
	return string(taken), nil
}

func (in *reader) binary() ([]byte, error) {
	taken, err := in.decoder.ReadBinary()
	if err != nil {
		return nil, unreadable(err, "bytes")
	}
	return taken, nil
}

func (in *reader) uint() (uint64, error) {
	value, err := in.decoder.ReadUnsigned()
	if err != nil {
		return 0, unreadable(err, "an unsigned integer")
	}
	if value > maxSafeInteger {
		return 0, fail("An integer is out of range")
	}
	return value, nil
}
