package keyword

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const corruptPrefix = "Invalid keyword segment: "

func Decode(payload []byte) (*Segment, error) {
	decoded, err := codec.Unmarshal(payload, codec.DecodeOptions{
		ErrorCode:   narsilerr.CodePersistenceLoadFailed,
		ShareBinary: true,
	})
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			corruptPrefix+"payload is not MessagePack: "+err.Error(), err, nil)
	}
	checker := NewChecker(corruptPrefix)
	raw := checker.Record(decoded, "payload")
	if checker.Failed() {
		return nil, checker.Err()
	}
	if version, isNumber := raw["v"].(float64); !isNumber || version != PayloadVersion {
		return nil, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"This keyword segment payload was written in another layout, and this build reads layout 1 alone",
			map[string]any{"version": raw["v"]})
	}
	segmentSchema, err := DecodeSchema(checker, raw["schema"])
	if err != nil {
		return nil, err
	}
	segment := parseSegment(checker, raw)
	if checker.Failed() {
		return nil, checker.Err()
	}
	segment.Schema = segmentSchema
	if err := segment.check(checker); err != nil {
		return nil, err
	}
	return segment, nil
}

func DecodeSchema(checker *Checker, raw any) (map[string]string, error) {
	record := checker.Record(raw, "schema")
	if checker.Failed() {
		return nil, checker.Err()
	}
	if err := schema.RequireValidFieldTypes(record); err != nil {
		return nil, err
	}
	flat := make(map[string]string, len(record))
	for path, value := range record {
		text, isText := value.(string)
		if !isText {
			return nil, narsilerr.New(narsilerr.CodeSchemaInvalidType,
				"Field \""+path+"\" has an invalid type definition", map[string]any{"field": path})
		}
		flat[path] = text
	}
	return flat, nil
}

func parseSegment(checker *Checker, raw map[string]any) *Segment {
	segment := &Segment{
		Tombstones:          checker.Strings(raw["tombstones"], "tombstones"),
		DocumentCount:       checker.Uint32(raw["documentCount"], "documentCount"),
		FieldNames:          checker.Strings(raw["fieldNames"], "fieldNames"),
		Tokens:              checker.Bytes(raw["tokens"], "tokens", 1),
		TokenOffsets:        checker.Bytes(raw["tokenOffsets"], "tokenOffsets", Uint32Bytes),
		DocumentFrequencies: checker.Bytes(raw["documentFrequencies"], "documentFrequencies", Uint32Bytes),
		PostingOffsets:      checker.Bytes(raw["postingOffsets"], "postingOffsets", Uint32Bytes),
		PostingDocuments:    checker.Bytes(raw["postingDocuments"], "postingDocuments", Uint32Bytes),
		PostingFrequencies:  checker.Bytes(raw["postingFrequencies"], "postingFrequencies", Uint16Bytes),
		PostingFields:       checker.Bytes(raw["postingFields"], "postingFields", Uint16Bytes),
		IDs:                 checker.Bytes(raw["ids"], "ids", 1),
		IDOffsets:           checker.Bytes(raw["idOffsets"], "idOffsets", Uint32Bytes),
		IDOrder:             checker.Bytes(raw["idOrder"], "idOrder", Uint32Bytes),
		Documents:           checker.Bytes(raw["documents"], "documents", 1),
		DocumentOffsets:     checker.Bytes(raw["documentOffsets"], "documentOffsets", Uint32Bytes),
	}
	if len(segment.FieldNames) > MaxFieldNames {
		checker.Fail("fieldNames holds "+itoa(len(segment.FieldNames))+" names, above the limit of "+
			itoa(MaxFieldNames), nil)
	}
	positionOffsets, hasPositionOffsets := checker.BytesOrNil(raw["positionOffsets"], "positionOffsets", Uint32Bytes)
	positions, hasPositions := checker.BytesOrNil(raw["positions"], "positions", Uint32Bytes)
	if hasPositionOffsets != hasPositions {
		checker.Fail("positionOffsets and positions must both be nil or both hold bytes", nil)
	}
	segment.TracksPositions = hasPositionOffsets && hasPositions
	segment.PositionOffsets = positionOffsets
	segment.Positions = positions
	segment.FieldLengths = checker.ParseFieldLengths(raw["fieldLengths"])
	segment.Numeric = checker.ParseValueColumns(raw["numeric"], "numeric")
	segment.Sizes = checker.ParseValueColumns(raw["sizes"], "sizes")
	segment.Boolean = checker.ParseBooleanColumns(raw["boolean"])
	segment.Enum = checker.ParseEnumColumns(raw["enum"])
	segment.Geopoint = checker.ParseGeopointColumns(raw["geopoint"])
	segment.Pattern = checker.ParsePatternColumns(raw["pattern"])
	segment.SurfaceForms = checker.ParseSurfaceForms(raw["surfaceForms"])
	segment.PartialWords = checker.ParsePartialWords(raw["partialWords"])
	seqNos, hasSeqNos := checker.BytesOrNil(raw["seqNos"], "seqNos", Uint64Bytes)
	primaryTerms, hasPrimaryTerms := checker.BytesOrNil(raw["primaryTerms"], "primaryTerms", Uint64Bytes)
	if hasSeqNos != hasPrimaryTerms {
		checker.Fail("seqNos and primaryTerms must both be present or both absent", nil)
	}
	segment.HasWriteRecords = hasSeqNos && hasPrimaryTerms
	segment.SeqNos = seqNos
	segment.PrimaryTerms = primaryTerms
	return segment
}
