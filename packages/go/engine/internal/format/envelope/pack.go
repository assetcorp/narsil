package envelope

import (
	"io"
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

func WriteChunks(writer io.Writer, formatVersion uint8, chunks [][]byte, what string) (int64, error) {
	var payloadLength int64
	state := codec.CRC32Init()
	for _, chunk := range chunks {
		payloadLength += int64(len(chunk))
		state = codec.CRC32Update(state, chunk)
	}
	header, err := ChecksummedHeader(formatVersion, payloadLength, codec.CRC32Final(state), what)
	if err != nil {
		return 0, err
	}
	if _, err := writer.Write(AppendHeader(nil, header)); err != nil {
		return 0, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The "+what+" fails to write", err, nil)
	}
	for _, chunk := range chunks {
		if _, err := writer.Write(chunk); err != nil {
			return 0, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The "+what+" fails to write", err, nil)
		}
	}
	return int64(HeaderBytes) + payloadLength, nil
}
