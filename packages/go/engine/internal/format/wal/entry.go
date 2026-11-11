package wal

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Operation string

const (
	OperationIndex  Operation = "INDEX"
	OperationDelete Operation = "DELETE"

	checksumFieldCount             = 7
	checksumFieldCountWithPrevious = 8
	entryFieldCount                = 8
	entryFieldCountWithPrevious    = 9
	previousDocumentKey            = "previousDocument"
)

type PreviousDocumentState uint8

const (
	PreviousDocumentAbsent PreviousDocumentState = iota
	PreviousDocumentNone
	PreviousDocumentHeld
)

type Entry struct {
	SeqNo            uint64
	PrimaryTerm      uint64
	Operation        Operation
	PartitionID      uint32
	IndexName        string
	DocumentID       string
	Document         []byte
	Previous         PreviousDocumentState
	PreviousDocument []byte
	Checksum         uint32
}

func (entry Entry) HoldsPreviousDocumentKey() bool {
	return entry.Previous != PreviousDocumentAbsent
}

func appendPreviousDocument(destination []byte, entry Entry) []byte {
	if entry.Previous == PreviousDocumentHeld {
		return codec.AppendBinary(destination, entry.PreviousDocument)
	}
	return codec.AppendNil(destination)
}

func appendDocument(destination []byte, document []byte) []byte {
	if document == nil {
		return codec.AppendNil(destination)
	}
	return codec.AppendBinary(destination, document)
}

const checksumHeadBytes = 64

func updateWithString(state uint32, scratch []byte, value string) uint32 {
	state = codec.CRC32Update(state, codec.AppendStringHeader(scratch[:0], len(value)))
	return crc32UpdateString(state, value)
}

func crc32UpdateString(state uint32, value string) uint32 {
	var chunk [checksumHeadBytes]byte
	for len(value) > 0 {
		copied := copy(chunk[:], value)
		state = codec.CRC32Update(state, chunk[:copied])
		value = value[copied:]
	}
	return state
}

func (entry Entry) ComputeChecksum() uint32 {
	var scratch [checksumHeadBytes]byte
	fieldCount := checksumFieldCount
	if entry.HoldsPreviousDocumentKey() {
		fieldCount = checksumFieldCountWithPrevious
	}
	head := codec.AppendArrayHeader(scratch[:0], fieldCount)
	head = codec.AppendNumber(head, float64(entry.SeqNo), false)
	head = codec.AppendNumber(head, float64(entry.PrimaryTerm), false)
	head = codec.AppendString(head, string(entry.Operation))
	head = codec.AppendNumber(head, float64(entry.PartitionID), false)
	state := codec.CRC32Update(codec.CRC32Init(), head)
	state = updateWithString(state, scratch[:], entry.IndexName)
	state = updateWithString(state, scratch[:], entry.DocumentID)
	state = updateWithBody(state, scratch[:], entry.Document, entry.Document != nil)
	if entry.HoldsPreviousDocumentKey() {
		state = updateWithBody(state, scratch[:], entry.PreviousDocument, entry.Previous == PreviousDocumentHeld)
	}
	return codec.CRC32Final(state)
}

func updateWithBody(state uint32, scratch []byte, body []byte, held bool) uint32 {
	if !held {
		return codec.CRC32Update(state, codec.AppendNil(scratch[:0]))
	}
	state = codec.CRC32Update(state, codec.AppendBinaryHeader(scratch[:0], len(body)))
	return codec.CRC32Update(state, body)
}

func Build(entry Entry) Entry {
	entry.Checksum = entry.ComputeChecksum()
	return entry
}

func (entry Entry) validate(code string) error {
	if entry.SeqNo > form.MaxSafeInteger || entry.PrimaryTerm > form.MaxSafeInteger {
		return narsilerr.New(code, "A log entry holds a seqNo or primaryTerm above 9007199254740991", nil)
	}
	if entry.Operation != OperationIndex && entry.Operation != OperationDelete {
		return narsilerr.New(code, "A log entry holds an operation other than \"INDEX\" or \"DELETE\"",
			map[string]any{"operation": string(entry.Operation)})
	}
	if entry.Operation == OperationIndex && entry.Document == nil {
		return narsilerr.New(code, "An INDEX log entry holds no document", nil)
	}
	if entry.Previous > PreviousDocumentHeld {
		return narsilerr.New(code, "A log entry holds a previous document state that the format lacks", nil)
	}
	return nil
}

func AppendEntry(destination []byte, entry Entry) ([]byte, error) {
	if err := entry.validate(narsilerr.CodePersistenceSaveFailed); err != nil {
		return destination, err
	}
	fieldCount := entryFieldCount
	if entry.HoldsPreviousDocumentKey() {
		fieldCount = entryFieldCountWithPrevious
	}
	destination = codec.AppendMapHeader(destination, fieldCount)
	destination = codec.AppendNumber(codec.AppendString(destination, "seqNo"), float64(entry.SeqNo), false)
	destination = codec.AppendNumber(codec.AppendString(destination, "primaryTerm"), float64(entry.PrimaryTerm), false)
	destination = codec.AppendString(codec.AppendString(destination, "operation"), string(entry.Operation))
	destination = codec.AppendNumber(codec.AppendString(destination, "partitionId"), float64(entry.PartitionID), false)
	destination = codec.AppendString(codec.AppendString(destination, "indexName"), entry.IndexName)
	destination = codec.AppendString(codec.AppendString(destination, "documentId"), entry.DocumentID)
	destination = appendDocument(codec.AppendString(destination, "document"), entry.Document)
	if entry.HoldsPreviousDocumentKey() {
		destination = appendPreviousDocument(codec.AppendString(destination, previousDocumentKey), entry)
	}
	destination = codec.AppendNumber(codec.AppendString(destination, "checksum"), float64(entry.Checksum), false)
	return destination, nil
}

type entryReader struct {
	decoder *codec.Decoder
	code    string
}

func (reader entryReader) unsigned(maximum uint64, field string) (uint64, error) {
	number, err := reader.decoder.ReadNumber()
	if err != nil {
		return 0, err
	}
	if number < 0 || number != math.Trunc(number) || number > float64(maximum) || number > form.MaxSafeInteger {
		return 0, reader.decoder.Errorf("The log entry field %q is not an integer from 0 to %d", field,
			min(maximum, form.MaxSafeInteger))
	}
	return uint64(number), nil
}

const (
	seenSeqNo = 1 << iota
	seenPrimaryTerm
	seenOperation
	seenPartitionID
	seenIndexName
	seenDocumentID
	seenChecksum
	seenRequired = seenSeqNo | seenPrimaryTerm | seenOperation | seenPartitionID | seenIndexName |
		seenDocumentID | seenChecksum
)

func (reader entryReader) field(key []byte, entry *Entry) (int, error) {
	var err error
	switch string(key) {
	case "seqNo":
		entry.SeqNo, err = reader.unsigned(math.MaxUint64, "seqNo")
		return seenSeqNo, err
	case "primaryTerm":
		entry.PrimaryTerm, err = reader.unsigned(math.MaxUint64, "primaryTerm")
		return seenPrimaryTerm, err
	case "operation":
		operation, readErr := reader.decoder.ReadStringBytes()
		entry.Operation = Operation(operation)
		return seenOperation, readErr
	case "partitionId":
		partition, readErr := reader.unsigned(math.MaxUint32, "partitionId")
		entry.PartitionID = uint32(partition)
		return seenPartitionID, readErr
	case "indexName":
		entry.IndexName, err = reader.decoder.ReadString()
		return seenIndexName, err
	case "documentId":
		entry.DocumentID, err = reader.decoder.ReadString()
		return seenDocumentID, err
	case "document":
		if reader.decoder.TryReadNil() {
			entry.Document = nil
			return 0, nil
		}
		entry.Document, err = reader.decoder.ReadBinary()
		return 0, err
	case previousDocumentKey:
		if reader.decoder.TryReadNil() {
			entry.Previous, entry.PreviousDocument = PreviousDocumentNone, nil
			return 0, nil
		}
		entry.Previous = PreviousDocumentHeld
		entry.PreviousDocument, err = reader.decoder.ReadBinary()
		return 0, err
	case "checksum":
		checksum, readErr := reader.unsigned(math.MaxUint32, "checksum")
		entry.Checksum = uint32(checksum)
		return seenChecksum, readErr
	}
	return 0, reader.decoder.Skip()
}

func DecodeEntry(payload []byte, code string) (Entry, error) {
	decoder := codec.NewDecoder(payload, codec.DecodeOptions{ErrorCode: code, ShareBinary: true})
	reader := entryReader{decoder: decoder, code: code}
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return Entry{}, err
	}
	var entry Entry
	seen := 0
	for range count {
		key, err := decoder.ReadStringBytes()
		if err != nil {
			return Entry{}, err
		}
		mark, err := reader.field(key, &entry)
		if err != nil {
			return Entry{}, err
		}
		seen |= mark
	}
	if decoder.More() {
		return Entry{}, decoder.Errorf("The log entry holds %d bytes after its map", decoder.Remaining())
	}
	if seen&seenRequired != seenRequired {
		return Entry{}, narsilerr.New(code, "A log entry lacks one of its required fields", nil)
	}
	if err := entry.validate(code); err != nil {
		return Entry{}, err
	}
	if entry.ComputeChecksum() != entry.Checksum {
		return Entry{}, narsilerr.New(code, "A log entry fails its logical entry checksum",
			map[string]any{"seqNo": entry.SeqNo})
	}
	return entry, nil
}
