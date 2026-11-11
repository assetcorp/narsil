package wal

import (
	"encoding/binary"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	SegmentHeaderBytes                 = 8
	FormatVersion                      = 1
	FormatVersionWithPreviousDocuments = 2
	HighestFormatVersion               = FormatVersionWithPreviousDocuments

	magicText           = "NRSW"
	formatVersionOffset = 4
	recordLengthBytes   = 4
	frameCRCBytes       = 4
)

func AppendSegmentHeader(destination []byte) []byte {
	return AppendSegmentHeaderOfVersion(destination, FormatVersion)
}

func AppendSegmentHeaderOfVersion(destination []byte, version uint8) []byte {
	destination = append(destination, magicText...)
	return append(destination, version, 0, 0, 0)
}

func VersionFor(holdsPreviousDocuments bool) uint8 {
	if holdsPreviousDocuments {
		return FormatVersionWithPreviousDocuments
	}
	return FormatVersion
}

func CheckSegmentHeader(data []byte) (uint8, error) {
	if len(data) < SegmentHeaderBytes {
		return 0, narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
			"The log segment is shorter than its 8-byte header", map[string]any{"bytes": len(data)})
	}
	if string(data[:len(magicText)]) != magicText {
		return 0, narsilerr.New(narsilerr.CodePersistenceWalCorrupt,
			"The log segment does not start with the NRSW magic bytes", nil)
	}
	version := data[formatVersionOffset]
	if version > HighestFormatVersion {
		return 0, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"The log segment holds format version "+strconv.Itoa(int(version))+
				", while this build reads up to version "+strconv.Itoa(HighestFormatVersion)+
				", so a newer release wrote it", map[string]any{"version": version, "maximum": HighestFormatVersion})
	}
	return version, nil
}

type FrameRead struct {
	Entry  Entry
	End    int
	Needed int
}

func ReadFrameAt(data []byte, offset int) (FrameRead, error) {
	if offset+recordLengthBytes > len(data) {
		return FrameRead{Needed: recordLengthBytes}, nil
	}
	length := int64(binary.BigEndian.Uint32(data[offset:]))
	if length == 0 || length > MaxRecordBytes {
		return FrameRead{}, corrupt(durableProblemMessages[frameLengthInvalid], map[string]any{"offset": offset})
	}
	whole := recordLengthBytes + int(length) + frameCRCBytes
	if offset+whole > len(data) {
		return FrameRead{Needed: whole}, nil
	}
	record, problem := frameAt(data, offset, len(data))
	if problem != frameComplete {
		return FrameRead{}, corrupt(durableProblemMessages[problem], map[string]any{"offset": offset})
	}
	entry, err := DecodeEntry(record.payload, narsilerr.CodePersistenceWalCorrupt)
	if err != nil {
		return FrameRead{}, narsilerr.Wrap(narsilerr.CodePersistenceWalCorrupt,
			"A log record payload fails to decode", err, map[string]any{"offset": offset})
	}
	return FrameRead{Entry: entry, End: record.end}, nil
}

type frame struct {
	payload []byte
	end     int
}

type frameProblem uint8

const (
	frameComplete frameProblem = iota
	frameLengthOverruns
	frameLengthInvalid
	frameOverruns
	frameChecksumFails
)

func frameAt(data []byte, offset int, limit int) (frame, frameProblem) {
	if offset+recordLengthBytes > limit {
		return frame{}, frameLengthOverruns
	}
	length := int64(binary.BigEndian.Uint32(data[offset:]))
	if length == 0 || length > MaxRecordBytes {
		return frame{}, frameLengthInvalid
	}
	payloadStart := offset + recordLengthBytes
	crcStart := int64(payloadStart) + length
	frameEnd := crcStart + frameCRCBytes
	if frameEnd > int64(limit) {
		return frame{}, frameOverruns
	}
	payload := data[payloadStart:crcStart]
	if codec.CRC32(payload) != binary.BigEndian.Uint32(data[crcStart:]) {
		return frame{}, frameChecksumFails
	}
	return frame{payload: payload, end: int(frameEnd)}, frameComplete
}

func corrupt(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceWalCorrupt, message, details)
}

var durableProblemMessages = map[frameProblem]string{
	frameLengthOverruns: "A log record length field overruns the durable region",
	frameLengthInvalid:  "A log record length is zero or above the largest record size",
	frameOverruns:       "A log record overruns the durable region",
	frameChecksumFails:  "A log record fails its frame checksum inside the durable region",
}

func ScanDurableRegion(data []byte, durableByteLength uint64, visit func(Entry) error) error {
	if _, err := CheckSegmentHeader(data); err != nil {
		return err
	}
	if durableByteLength < SegmentHeaderBytes || durableByteLength > uint64(len(data)) {
		return corrupt("The commit marker gives a durable byte length outside the log segment",
			map[string]any{"durableByteLength": durableByteLength, "segmentLength": len(data)})
	}
	limit := int(durableByteLength)
	offset := SegmentHeaderBytes
	var previous uint64
	read := 0
	for offset < limit {
		record, problem := frameAt(data, offset, limit)
		if problem != frameComplete {
			return corrupt(durableProblemMessages[problem], map[string]any{"offset": offset})
		}
		entry, err := DecodeEntry(record.payload, narsilerr.CodePersistenceWalCorrupt)
		if err != nil {
			return narsilerr.Wrap(narsilerr.CodePersistenceWalCorrupt,
				"A log record payload fails to decode inside the durable region", err,
				map[string]any{"offset": offset})
		}
		if read > 0 && entry.SeqNo <= previous {
			return corrupt("The log sequence numbers fail to increase strictly",
				map[string]any{"previousSeqNo": previous, "seqNo": entry.SeqNo})
		}
		if err := visit(entry); err != nil {
			return err
		}
		previous = entry.SeqNo
		read++
		offset = record.end
	}
	return nil
}

func ReadDurableRegion(data []byte, durableByteLength uint64) ([]Entry, error) {
	var entries []Entry
	err := ScanDurableRegion(data, durableByteLength, func(entry Entry) error {
		entries = append(entries, entry)
		return nil
	})
	return entries, err
}

func ScanTail(data []byte, durableByteLength uint64, lastDurableSeqNo uint64, visit func(Entry) error) (int, error) {
	offset := int(min(max(durableByteLength, SegmentHeaderBytes), uint64(len(data))))
	previous := lastDurableSeqNo
	for offset < len(data) {
		record, problem := frameAt(data, offset, len(data))
		if problem != frameComplete {
			break
		}
		entry, err := DecodeEntry(record.payload, narsilerr.CodePersistenceWalCorrupt)
		if err != nil || entry.SeqNo <= previous {
			break
		}
		if err := visit(entry); err != nil {
			return offset, err
		}
		previous = entry.SeqNo
		offset = record.end
	}
	return offset, nil
}

func AppendRecord(destination []byte, entry Entry) ([]byte, error) {
	start := len(destination)
	destination = append(destination, 0, 0, 0, 0)
	destination, err := AppendEntry(destination, entry)
	if err != nil {
		return destination[:start], err
	}
	length := len(destination) - start - recordLengthBytes
	if length > MaxRecordBytes {
		return destination[:start], narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"The log record would take "+strconv.Itoa(length)+" bytes, above the largest record size of "+
				strconv.Itoa(MaxRecordBytes), map[string]any{"bytes": length, "maximum": MaxRecordBytes})
	}
	binary.BigEndian.PutUint32(destination[start:], uint32(length))
	payload := destination[start+recordLengthBytes:]
	return binary.BigEndian.AppendUint32(destination, codec.CRC32(payload)), nil
}
