package paged

import (
	"bytes"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (reader *Reader) RequirePayloadChecksum() error {
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
	if err := reader.RequirePayloadChecksum(); err != nil {
		return err
	}
	if err := reader.requireEveryPage(); err != nil {
		return err
	}
	for ordinal := range reader.Head.DocumentCount {
		if _, err := reader.Document(ordinal); err != nil {
			return err
		}
		if _, _, _, err := reader.WriteRecord(ordinal); err != nil {
			return err
		}
		if _, err := reader.RemovalEntry(ordinal); err != nil {
			return err
		}
	}
	if err := reader.requireOffsetsStartAtZero(); err != nil {
		return err
	}
	if err := reader.requireIDOrder(); err != nil {
		return err
	}
	if err := reader.requirePostings(); err != nil {
		return err
	}
	_, err := reader.SurfaceForms()
	return err
}

func OpenBytes(data []byte) (*Reader, error) {
	return Open(bytes.NewReader(data), int64(len(data)))
}

func (reader *Reader) requireEveryPage() error {
	for _, section := range reader.Head.Sections {
		page := make([]byte, section.PageBytes)
		for at := range section.PageCount() {
			length := min(section.PageBytes, section.Length-at*section.PageBytes)
			if err := readPageOf(reader.source, section, at, page[:length], what); err != nil {
				return err
			}
		}
	}
	return nil
}

func (reader *Reader) requireStartsAtZero(name string, message string) error {
	section, err := reader.Section(name)
	if err != nil {
		return err
	}
	first, err := reader.uint32At(section, 0)
	if err != nil {
		return err
	}
	if first != 0 {
		return loadFailed(message, map[string]any{"section": name})
	}
	return nil
}

func (reader *Reader) requireOffsetsStartAtZero() error {
	if reader.Head.DocumentCount == 0 {
		for _, name := range []string{"idOffsets", "removalOffsets"} {
			if err := reader.requireStartsAtZero(name,
				"Section \""+name+"\" of the "+what+" does not start at zero"); err != nil {
				return err
			}
		}
	}
	offsets := reader.Resident.PostingOffsets
	if reader.Resident.TracksPositions && offsets.Len() > 0 && offsets.At(offsets.Len()-1) == 0 {
		return reader.requireStartsAtZero("positionOffsets",
			"The position offsets of the "+what+" do not start at zero")
	}
	return nil
}

func (reader *Reader) requireIDOrder() error {
	sample := reader.Resident.IDSample
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
		if position%IDSampleInterval == 0 {
			entry := int(position / IDSampleInterval)
			if entry >= len(sample) || sample[entry].ID != string(id) {
				return loadFailed("The ID sample of the "+what+" differs at position "+itoaInt(int(position)),
					map[string]any{"position": position})
			}
		}
		previous = id
	}
	return nil
}
