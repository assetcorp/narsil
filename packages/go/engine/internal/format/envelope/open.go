package envelope

import (
	"errors"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Kind struct {
	FormatVersion uint8
	What          string
	AllowsGzip    bool
}

type Opened struct {
	Header  Header
	Payload []byte
}

func versionMismatch(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch, message, details)
}

func loadFailed(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, details)
}

func inflate(compressed []byte, what string) ([]byte, error) {
	inflated, err := codec.Gunzip(compressed, MaxFileBytes, narsilerr.CodePersistenceLoadFailed)
	if err == nil {
		return inflated, nil
	}
	if errors.Is(err, codec.ErrInflatesPastLimit) {
		return nil, loadFailed("The "+what+" inflates past the file size limit of "+
			strconv.Itoa(MaxFileBytes)+" bytes", map[string]any{"maximum": MaxFileBytes})
	}
	return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
		"The "+what+" holds a gzip payload that fails to inflate", err, nil)
}

func requireChecksum(header Header, payload []byte, what string) error {
	computed := codec.CRC32(payload)
	if computed == header.Checksum {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
		"The checksum of the "+what+" does not match its payload",
		map[string]any{"expected": header.Checksum, "computed": computed})
}

func OpenChecksummed(data []byte, kind Kind) (Opened, error) {
	header, err := ParseHeader(data)
	if err != nil {
		return Opened{}, err
	}
	if header.FormatVersion != kind.FormatVersion {
		return Opened{}, versionMismatch("The "+kind.What+" holds envelope format v"+
			strconv.Itoa(int(header.FormatVersion))+", while this build reads it as v"+
			strconv.Itoa(int(kind.FormatVersion)),
			map[string]any{"version": header.FormatVersion, "expected": kind.FormatVersion})
	}
	if header.Encrypted() {
		return Opened{}, versionMismatch("The "+kind.What+" is encrypted, which this build cannot read", nil)
	}
	if header.Compressed() && !kind.AllowsGzip {
		return Opened{}, loadFailed("The "+kind.What+" is compressed, while its format stores it raw", nil)
	}
	if header.Compressed() && header.Algorithm() != CompressionGzip {
		return Opened{}, versionMismatch("The "+kind.What+" uses "+header.Algorithm().String()+
			" compression, which this build cannot read", nil)
	}
	if !header.HasChecksum() {
		return Opened{}, loadFailed("The "+kind.What+" carries no checksum, while its format requires one", nil)
	}
	expected := int64(HeaderBytes) + int64(header.PayloadLength)
	if int64(len(data)) != expected {
		return Opened{}, loadFailed("The "+kind.What+" holds "+strconv.Itoa(len(data))+
			" bytes where its header gives "+strconv.FormatInt(expected, 10),
			map[string]any{"bytes": len(data), "expected": expected})
	}
	payload := data[HeaderBytes:]
	if err := requireChecksum(header, payload, kind.What); err != nil {
		return Opened{}, err
	}
	if !header.Compressed() {
		return Opened{Header: header, Payload: payload}, nil
	}
	inflated, err := inflate(payload, kind.What)
	if err != nil {
		return Opened{}, err
	}
	return Opened{Header: header, Payload: inflated}, nil
}

func OpenUpTo(data []byte, maxFormatVersion uint8, what string) (Opened, error) {
	header, err := ParseHeader(data)
	if err != nil {
		return Opened{}, err
	}
	if header.FormatVersion > maxFormatVersion {
		return Opened{}, versionMismatch("The "+what+" holds envelope format v"+
			strconv.Itoa(int(header.FormatVersion))+", while this build reads up to v"+
			strconv.Itoa(int(maxFormatVersion)),
			map[string]any{"version": header.FormatVersion, "maximum": maxFormatVersion})
	}
	if header.Encrypted() {
		return Opened{}, versionMismatch("The "+what+" is encrypted, which this build cannot read", nil)
	}
	algorithm := header.Algorithm()
	if header.Compressed() && algorithm != CompressionGzip && algorithm != CompressionNone {
		return Opened{}, versionMismatch("The "+what+" uses "+algorithm.String()+
			" compression, which this build cannot read", nil)
	}
	available := int64(len(data) - HeaderBytes)
	if available < int64(header.PayloadLength) {
		return Opened{}, loadFailed("The "+what+" is truncated: its header gives "+
			strconv.FormatUint(uint64(header.PayloadLength), 10)+" bytes of payload, while "+
			strconv.FormatInt(available, 10)+" bytes follow the header",
			map[string]any{"payloadLength": header.PayloadLength, "available": available})
	}
	payload := data[HeaderBytes : HeaderBytes+int(header.PayloadLength)]
	if header.HasChecksum() {
		if err := requireChecksum(header, payload, what); err != nil {
			return Opened{}, err
		}
	}
	if !header.Compressed() {
		return Opened{Header: header, Payload: payload}, nil
	}
	inflated, err := inflate(payload, what)
	if err != nil {
		return Opened{}, err
	}
	return Opened{Header: header, Payload: inflated}, nil
}
