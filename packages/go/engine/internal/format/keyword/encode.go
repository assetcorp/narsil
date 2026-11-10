package keyword

import (
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	topLevelEntries    = 28
	writeRecordEntries = 2
)

type Chunks struct {
	list [][]byte
	head []byte
}

func (chunks *Chunks) Map(entries int) {
	chunks.head = codec.AppendMapHeader(chunks.head, entries)
}

func (chunks *Chunks) Array(items int) {
	chunks.head = codec.AppendArrayHeader(chunks.head, items)
}

func (chunks *Chunks) Key(name string) {
	chunks.head = codec.AppendString(chunks.head, name)
}

func (chunks *Chunks) Nil() {
	chunks.head = codec.AppendNil(chunks.head)
}

func (chunks *Chunks) Number(value float64) {
	chunks.head = codec.AppendNumber(chunks.head, value, false)
}

func (chunks *Chunks) Strings(values []string) {
	chunks.Array(len(values))
	for _, value := range values {
		chunks.head = codec.AppendString(chunks.head, value)
	}
}

func (chunks *Chunks) StringMap(values map[string]string) {
	record := make(map[string]any, len(values))
	for key, value := range values {
		record[key] = value
	}
	chunks.Map(len(record))
	for _, key := range codec.ObjectKeyOrder(record) {
		chunks.Key(key)
		chunks.head = codec.AppendString(chunks.head, values[key])
	}
}

func (chunks *Chunks) Binary(data []byte) {
	chunks.head = codec.AppendBinaryHeader(chunks.head, len(data))
	if len(data) < InlineBinaryBytes {
		chunks.head = append(chunks.head, data...)
		return
	}
	chunks.flush()
	chunks.list = append(chunks.list, data)
}

func (chunks *Chunks) flush() {
	if len(chunks.head) > 0 {
		chunks.list = append(chunks.list, chunks.head)
		chunks.head = nil
	}
}

func (chunks *Chunks) Finish() [][]byte {
	chunks.flush()
	return chunks.list
}

func (chunks *Chunks) Joined() []byte {
	parts := chunks.Finish()
	total := 0
	for _, part := range parts {
		total += len(part)
	}
	joined := make([]byte, 0, total)
	for _, part := range parts {
		joined = append(joined, part...)
	}
	return joined
}

func (chunks *Chunks) BinaryOrNil(data []byte, present bool) {
	if !present {
		chunks.Nil()
		return
	}
	chunks.Binary(data)
}

func (segment *Segment) PayloadChunks() ([][]byte, error) {
	if err := segment.Validate(); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The keyword segment breaks a rule of its format, so it cannot be written", err, nil)
	}
	chunks := &Chunks{}
	entries := topLevelEntries
	if segment.HasWriteRecords {
		entries += writeRecordEntries
	}
	chunks.Map(entries)
	chunks.Key("v")
	chunks.Number(PayloadVersion)
	chunks.Key("schema")
	chunks.StringMap(segment.Schema)
	chunks.Key("tombstones")
	chunks.Strings(segment.Tombstones)
	chunks.Key("documentCount")
	chunks.Number(float64(segment.DocumentCount))
	for _, entry := range []struct {
		key  string
		data []byte
	}{
		{"ids", segment.IDs}, {"idOffsets", segment.IDOffsets}, {"idOrder", segment.IDOrder},
		{"documents", segment.Documents}, {"documentOffsets", segment.DocumentOffsets},
	} {
		chunks.Key(entry.key)
		chunks.Binary(entry.data)
	}
	chunks.Key("fieldNames")
	chunks.Strings(segment.FieldNames)
	for _, entry := range []struct {
		key  string
		data []byte
	}{
		{"tokens", segment.Tokens}, {"tokenOffsets", segment.TokenOffsets},
		{"documentFrequencies", segment.DocumentFrequencies}, {"postingOffsets", segment.PostingOffsets},
		{"postingDocuments", segment.PostingDocuments}, {"postingFrequencies", segment.PostingFrequencies},
		{"postingFields", segment.PostingFields},
	} {
		chunks.Key(entry.key)
		chunks.Binary(entry.data)
	}
	chunks.Key("positionOffsets")
	chunks.BinaryOrNil(segment.PositionOffsets, segment.TracksPositions)
	chunks.Key("positions")
	chunks.BinaryOrNil(segment.Positions, segment.TracksPositions)
	segment.appendColumns(chunks)
	if segment.HasWriteRecords {
		chunks.Key("seqNos")
		chunks.Binary(segment.SeqNos)
		chunks.Key("primaryTerms")
		chunks.Binary(segment.PrimaryTerms)
	}
	return chunks.Finish(), nil
}

func (segment *Segment) appendColumns(chunks *Chunks) {
	chunks.Key("fieldLengths")
	chunks.FieldLengths(segment.FieldLengths)
	chunks.Key("numeric")
	chunks.ValueColumns(segment.Numeric)
	chunks.Key("sizes")
	chunks.ValueColumns(segment.Sizes)
	chunks.Key("boolean")
	chunks.BooleanColumns(segment.Boolean)
	chunks.Key("enum")
	chunks.EnumColumns(segment.Enum)
	chunks.Key("geopoint")
	chunks.GeopointColumns(segment.Geopoint)
	chunks.Key("pattern")
	chunks.PatternColumns(segment.Pattern)
	chunks.Key("surfaceForms")
	chunks.SurfaceForms(segment.SurfaceForms)
	chunks.Key("partialWords")
	chunks.PartialWords(segment.PartialWords)
}

type Written struct {
	Bytes    int64
	Checksum uint32
}

func WriteChecksummed(writer io.Writer, formatVersion uint8, chunks [][]byte, what string) (Written, error) {
	var payloadLength int64
	state := codec.CRC32Init()
	for _, chunk := range chunks {
		payloadLength += int64(len(chunk))
		state = codec.CRC32Update(state, chunk)
	}
	checksum := codec.CRC32Final(state)
	header, err := envelope.ChecksummedHeader(formatVersion, payloadLength, checksum, what)
	if err != nil {
		return Written{}, err
	}
	if _, err := writer.Write(envelope.AppendHeader(nil, header)); err != nil {
		return Written{}, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The "+what+" fails to write", err, nil)
	}
	for _, chunk := range chunks {
		if _, err := writer.Write(chunk); err != nil {
			return Written{}, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The "+what+" fails to write", err, nil)
		}
	}
	return Written{Bytes: int64(envelope.HeaderBytes) + payloadLength, Checksum: checksum}, nil
}

func Write(writer io.Writer, segment *Segment) (Written, error) {
	chunks, err := segment.PayloadChunks()
	if err != nil {
		return Written{}, err
	}
	return WriteChecksummed(writer, EnvelopeVersion, chunks, what)
}

func Pack(segment *Segment, gzip bool) ([]byte, error) {
	chunks, err := segment.PayloadChunks()
	if err != nil {
		return nil, err
	}
	payload := (&Chunks{list: chunks}).Joined()
	return envelope.Pack(payload, envelope.PackOptions{
		FormatVersion: EnvelopeVersion,
		What:          what,
		Gzip:          gzip,
		Checksum:      true,
	})
}
