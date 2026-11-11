package keyword

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	PayloadVersion  = 1
	EnvelopeVersion = 4
	CodePointsInRun = 3
	what            = "keyword segment"
)

type Segment struct {
	Schema              map[string]string
	SchemaOrder         []string
	Tombstones          []string
	DocumentCount       uint32
	IDs                 []byte
	IDOffsets           Uint32s
	IDOrder             Uint32s
	Documents           []byte
	DocumentOffsets     Uint32s
	FieldNames          []string
	Tokens              []byte
	TokenOffsets        Uint32s
	DocumentFrequencies Uint32s
	PostingOffsets      Uint32s
	PostingDocuments    Uint32s
	PostingFrequencies  Uint16s
	PostingFields       Uint16s
	TracksPositions     bool
	PositionOffsets     Uint32s
	Positions           Uint32s
	FieldLengths        []FieldLengthColumn
	Numeric             []ValueColumn
	Sizes               []ValueColumn
	Boolean             []BooleanColumn
	Enum                []EnumColumn
	Geopoint            []GeopointColumn
	Pattern             []PatternColumn
	SurfaceForms        *SurfaceFormColumn
	PartialWords        *PartialWordColumn
	HasWriteRecords     bool
	SeqNos              Uint64s
	PrimaryTerms        Uint64s
}

type FieldLengthColumn struct {
	Field   string
	Lengths Uint32s
}

type ValueColumn struct {
	Field     string
	Documents Uint32s
	Values    Float64s
}

type BooleanColumn struct {
	Field          string
	TrueDocuments  Uint32s
	FalseDocuments Uint32s
}

type EnumColumn struct {
	Field     string
	Values    []string
	Offsets   Uint32s
	Documents Uint32s
}

type GeopointColumn struct {
	Field      string
	Documents  Uint32s
	Latitudes  Float64s
	Longitudes Float64s
}

type PatternColumn struct {
	Field     string
	Documents Uint32s
	Runs      Uint32s
	Offsets   Uint32s
	Postings  Uint32s
}

type SurfaceFormColumn struct {
	Text    []byte
	Offsets Uint32s
	Counts  Uint32s
}

type PartialWordColumn struct {
	Fields     []string
	Text       []byte
	Offsets    Uint32s
	Tokens     Uint32s
	Counts     Uint32s
	Runs       Uint32s
	RunOffsets Uint32s
	RunEntries Uint32s
}

type File struct {
	Header  envelope.Header
	Segment *Segment
}

var Kind = envelope.Kind{FormatVersion: EnvelopeVersion, What: what, AllowsGzip: true}

func Open(file []byte) (File, error) {
	opened, err := envelope.OpenChecksummed(file, Kind)
	if err != nil {
		return File{}, err
	}
	segment, err := Decode(opened.Payload)
	if err != nil {
		return File{}, err
	}
	return File{Header: opened.Header, Segment: segment}, nil
}

func (segment *Segment) TokenCount() int {
	return segment.TokenOffsets.Len() - 1
}

func (segment *Segment) ID(ordinal int) string {
	return string(entryOf(segment.IDs, segment.IDOffsets, ordinal))
}

func (segment *Segment) Token(index int) string {
	return string(entryOf(segment.Tokens, segment.TokenOffsets, index))
}

func (segment *Segment) EncodedDocument(ordinal int) []byte {
	return entryOf(segment.Documents, segment.DocumentOffsets, ordinal)
}

func (segment *Segment) Document(ordinal int) (map[string]any, error) {
	document, err := codec.DecodeDocument(segment.EncodedDocument(ordinal),
		codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"Invalid keyword segment: document "+itoa(ordinal)+" is not a MessagePack map", err,
			map[string]any{"ordinal": ordinal})
	}
	return document, nil
}

func (segment *Segment) RequireDocuments() error {
	for ordinal := range int(segment.DocumentCount) {
		if _, err := segment.Document(ordinal); err != nil {
			return err
		}
	}
	return nil
}

func (column *SurfaceFormColumn) Surface(entry int) string {
	return string(entryOf(column.Text, column.Offsets, entry*2))
}

func (column *SurfaceFormColumn) SurfaceToken(entry int) string {
	return string(entryOf(column.Text, column.Offsets, entry*2+1))
}

func (column *PartialWordColumn) Spelling(entry int) string {
	return string(entryOf(column.Text, column.Offsets, entry))
}
