package envelope

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type PackOptions struct {
	FormatVersion uint8
	What          string
	Gzip          bool
	Checksum      bool
}

func RequireWithinFileLimit(byteLength int64, what string) error {
	if byteLength >= 0 && byteLength <= MaxFileBytes {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		"The "+what+" would take "+strconv.FormatInt(byteLength, 10)+
			" bytes, above the file size limit of "+strconv.Itoa(MaxFileBytes),
		map[string]any{"bytes": byteLength, "maximum": MaxFileBytes})
}

func Pack(payload []byte, options PackOptions) ([]byte, error) {
	stored := payload
	if options.Gzip {
		compressed, err := codec.Gzip(payload)
		if err != nil {
			return nil, err
		}
		stored = compressed
	}
	if err := RequireWithinFileLimit(int64(HeaderBytes)+int64(len(stored)), options.What); err != nil {
		return nil, err
	}
	header := Header{
		FormatVersion: options.FormatVersion,
		Engine:        CurrentEngineVersion,
		PayloadLength: uint32(len(stored)),
		Flags:         FlagsFor(options.Gzip, options.Checksum),
	}
	if options.Checksum {
		header.Checksum = codec.CRC32(stored)
	}
	packed := make([]byte, 0, HeaderBytes+len(stored))
	packed = AppendHeader(packed, header)
	return append(packed, stored...), nil
}

func ChecksummedHeader(formatVersion uint8, payloadLength int64, checksum uint32, what string) (Header, error) {
	if err := RequireWithinFileLimit(int64(HeaderBytes)+payloadLength, what); err != nil {
		return Header{}, err
	}
	return Header{
		FormatVersion: formatVersion,
		Engine:        CurrentEngineVersion,
		PayloadLength: uint32(payloadLength),
		Flags:         FlagChecksum,
		Checksum:      checksum,
	}, nil
}
