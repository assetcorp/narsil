package paged

import (
	"bytes"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (reader *Reader) requirePayloadChecksum() error {
	state := codec.CRC32Init()
	chunk := make([]byte, min(int64(ChecksumReadChunkBytes), max(reader.PayloadLength, 1)))
	for at := int64(0); at < reader.PayloadLength; at += int64(len(chunk)) {
		part := chunk[:min(int64(len(chunk)), reader.PayloadLength-at)]
		if err := reader.readAt(envelope.HeaderBytes+at, part); err != nil {
			return err
		}
		state = codec.CRC32Update(state, part)
	}
	computed := codec.CRC32Final(state)
	if computed != reader.Header.Checksum {
		return narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
			"The checksum of the "+what+" does not match its payload",
			map[string]any{"expected": reader.Header.Checksum, "computed": computed})
	}
	return nil
}

func (reader *Reader) CheckFully() error {
	if err := reader.requirePayloadChecksum(); err != nil {
		return err
	}
	count := reader.Head.DocumentCount
	for ordinal := range count {
		if _, err := reader.Document(ordinal); err != nil {
			return err
		}
	}
	if err := reader.requireIDOrderAscending(); err != nil {
		return err
	}
	for ordinal := range count {
		if _, err := reader.RemovalEntry(ordinal); err != nil {
			return err
		}
	}
	return reader.requireEveryList()
}

func (reader *Reader) requireIDOrderAscending() error {
	var previous []byte
	for position := range reader.Head.DocumentCount {
		ordinal, err := reader.SortedOrdinal(position)
		if err != nil {
			return err
		}
		id, err := reader.IDBytes(ordinal)
		if err != nil {
			return err
		}
		if position > 0 && bytes.Compare(previous, id) >= 0 {
			return loadFailed("The ID order of the "+what+" does not ascend at position "+itoaInt(int(position)),
				map[string]any{"position": position})
		}
		previous = id
	}
	return nil
}

func (reader *Reader) requireEveryList() error {
	_, hasTotals := reader.Head.Section("tokenTotals")
	for token := range reader.TokenCount() {
		if _, err := reader.PostingList(token); err != nil {
			return err
		}
		if _, _, err := reader.Positions(token); err != nil {
			return err
		}
		if _, _, err := reader.BlockBounds(token); err != nil {
			return err
		}
		if hasTotals {
			if _, err := reader.TokenTotal(token); err != nil {
				return err
			}
		}
	}
	for ordinal := range reader.Head.DocumentCount {
		if _, _, _, err := reader.WriteRecord(ordinal); err != nil {
			return err
		}
	}
	_, err := reader.SurfaceForms()
	return err
}

func OpenBytes(data []byte) (*Reader, error) {
	return Open(bytes.NewReader(data), int64(len(data)))
}
