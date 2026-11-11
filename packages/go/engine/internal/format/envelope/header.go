package envelope

import (
	"encoding/binary"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	HeaderBytes = 32

	magicText           = "NRSL"
	formatVersionOffset = 4
	engineMajorOffset   = 5
	engineMinorOffset   = 6
	enginePatchOffset   = 7
	payloadLengthOffset = 8
	flagsOffset         = 12
	checksumOffset      = 14

	FlagCompressed uint16 = 1 << 0
	FlagChecksum   uint16 = 1 << 3
	FlagEncrypted  uint16 = 1 << 4

	algorithmShift        = 1
	algorithmMask  uint16 = 0b11 << algorithmShift

	MaxPayloadBytes = 0xFFFF_FFFF
)

type Compression uint8

const (
	CompressionNone Compression = 0
	CompressionGzip Compression = 1
	CompressionLZ4  Compression = 2
	CompressionZstd Compression = 3
)

func (compression Compression) String() string {
	switch compression {
	case CompressionGzip:
		return "gzip"
	case CompressionLZ4:
		return "lz4"
	case CompressionZstd:
		return "zstd"
	default:
		return "none"
	}
}

type EngineVersion struct {
	Major uint8
	Minor uint8
	Patch uint8
}

var CurrentEngineVersion = EngineVersion{Major: 0, Minor: 1, Patch: 0}

type Header struct {
	FormatVersion uint8
	Engine        EngineVersion
	PayloadLength uint32
	Flags         uint16
	Checksum      uint32
}

func (header Header) Compressed() bool {
	return header.Flags&FlagCompressed != 0
}

func (header Header) Algorithm() Compression {
	return Compression((header.Flags & algorithmMask) >> algorithmShift)
}

func (header Header) HasChecksum() bool {
	return header.Flags&FlagChecksum != 0
}

func (header Header) Encrypted() bool {
	return header.Flags&FlagEncrypted != 0
}

func (header Header) Gzipped() bool {
	return header.Compressed() && header.Algorithm() == CompressionGzip
}

func FlagsFor(gzip bool, checksum bool) uint16 {
	var flags uint16
	if gzip {
		flags |= FlagCompressed | uint16(CompressionGzip)<<algorithmShift
	}
	if checksum {
		flags |= FlagChecksum
	}
	return flags
}

func ParseHeader(data []byte) (Header, error) {
	if len(data) < HeaderBytes {
		return Header{}, narsilerr.New(narsilerr.CodeEnvelopeInvalidMagic,
			"The data is shorter than the 32-byte .nrsl header", map[string]any{"bytes": len(data)})
	}
	if string(data[:len(magicText)]) != magicText {
		return Header{}, narsilerr.New(narsilerr.CodeEnvelopeInvalidMagic,
			"The data does not start with the NRSL magic bytes", nil)
	}
	return Header{
		FormatVersion: data[formatVersionOffset],
		Engine: EngineVersion{
			Major: data[engineMajorOffset],
			Minor: data[engineMinorOffset],
			Patch: data[enginePatchOffset],
		},
		PayloadLength: binary.BigEndian.Uint32(data[payloadLengthOffset:]),
		Flags:         binary.BigEndian.Uint16(data[flagsOffset:]),
		Checksum:      binary.BigEndian.Uint32(data[checksumOffset:]),
	}, nil
}

func AppendHeader(destination []byte, header Header) []byte {
	start := len(destination)
	destination = append(destination, make([]byte, HeaderBytes)...)
	encoded := destination[start:]
	copy(encoded, magicText)
	encoded[formatVersionOffset] = header.FormatVersion
	encoded[engineMajorOffset] = header.Engine.Major
	encoded[engineMinorOffset] = header.Engine.Minor
	encoded[enginePatchOffset] = header.Engine.Patch
	binary.BigEndian.PutUint32(encoded[payloadLengthOffset:], header.PayloadLength)
	binary.BigEndian.PutUint16(encoded[flagsOffset:], header.Flags)
	binary.BigEndian.PutUint32(encoded[checksumOffset:], header.Checksum)
	return destination
}

func ChecksumBytesOf(data []byte) (uint32, bool) {
	if len(data) < HeaderBytes {
		return 0, false
	}
	return binary.BigEndian.Uint32(data[checksumOffset:]), true
}
