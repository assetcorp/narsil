package segments

import (
	"fmt"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
)

func uint16sOf(column keyword.Uint16s) []uint16 {
	values := make([]uint16, column.Len())
	for at := range values {
		values[at] = column.At(at)
	}
	return values
}

func float64sOf(column keyword.Float64s) []float64 {
	values := make([]float64, column.Len())
	for at := range values {
		values[at] = column.At(at)
	}
	return values
}

func bitsOf(documents keyword.Uint32s, count uint32) ([]uint32, error) {
	words := make([]uint32, bitsetWords(count))
	for at := range documents.Len() {
		ordinal := documents.At(at)
		if ordinal >= count {
			return nil, fmt.Errorf("%w: a boolean column marks ordinal %d of %d documents", ErrInvalidInput, ordinal, count)
		}
		words[ordinal>>5] |= 1 << (ordinal & 31)
	}
	return words, nil
}

func numericIndexes(columns []keyword.ValueColumn) []Field[*core.NumericIndex] {
	indexes := make([]Field[*core.NumericIndex], 0, len(columns))
	for _, column := range columns {
		indexes = append(indexes, Field[*core.NumericIndex]{Path: column.Field,
			Index: &core.NumericIndex{Values: float64sOf(column.Values), Ordinals: valuesOf(column.Documents)}})
	}
	return indexes
}

func enumIndexOf(column keyword.EnumColumn) *core.EnumIndex {
	index := &core.EnumIndex{Offsets: make([]uint32, 1, len(column.Values)+1),
		PostingOffsets: valuesOf(column.Offsets), Postings: valuesOf(column.Documents),
		SuffixOrder: identitySlots(len(column.Values))}
	for _, value := range column.Values {
		index.Units = append(index.Units, utf16.Encode([]rune(value))...)
		index.Offsets = append(index.Offsets, uint32(len(index.Units)))
	}
	return index
}

func geoIndexOf(column keyword.GeopointColumn) *core.GeoIndex {
	index := &core.GeoIndex{Lat: float64sOf(column.Latitudes), Lon: float64sOf(column.Longitudes),
		Ordinals: valuesOf(column.Documents)}
	index.Codes = make([]uint64, len(index.Lat))
	for at := range index.Codes {
		if at < len(index.Lon) {
			index.Codes[at] = fields.LocationCode(index.Lat[at], index.Lon[at])
		}
	}
	return index
}

func fileFieldIndexes(file *keyword.Segment) (*FrozenFields, error) {
	held := &FrozenFields{Numeric: numericIndexes(file.Numeric), Sizes: numericIndexes(file.Sizes)}
	for _, column := range file.Boolean {
		marked, err := bitsOf(column.TrueDocuments, file.DocumentCount)
		if err != nil {
			return nil, err
		}
		cleared, err := bitsOf(column.FalseDocuments, file.DocumentCount)
		if err != nil {
			return nil, err
		}
		held.Boolean = append(held.Boolean, Field[*core.BooleanIndex]{Path: column.Field,
			Index: &core.BooleanIndex{TrueBits: marked, FalseBits: cleared}})
	}
	for _, column := range file.Enum {
		held.Enum = append(held.Enum, Field[*core.EnumIndex]{Path: column.Field, Index: enumIndexOf(column)})
	}
	for _, column := range file.Geopoint {
		held.Geo = append(held.Geo, Field[*core.GeoIndex]{Path: column.Field, Index: geoIndexOf(column)})
	}
	for _, column := range file.Pattern {
		held.Pattern = append(held.Pattern, Field[*core.PatternIndex]{Path: column.Field,
			Index: &core.PatternIndex{Documents: valuesOf(column.Documents), Runs: valuesOf(column.Runs),
				Offsets: valuesOf(column.Offsets), Postings: valuesOf(column.Postings)}})
	}
	return held, nil
}

func fileKeyword(file *keyword.Segment) Keyword {
	held := heldKeyword(keywordColumns{fieldNames: file.FieldNames, tokens: file.Tokens,
		tokenOffsets: file.TokenOffsets, frequencies: file.DocumentFrequencies, postingOffsets: file.PostingOffsets,
		fieldLengths: file.FieldLengths, surfaces: file.SurfaceForms, partialWords: file.PartialWords,
		documentCount: file.DocumentCount})
	held.Segment.PostingDocuments = valuesOf(file.PostingDocuments)
	held.Segment.PostingFrequencies = uint16sOf(file.PostingFrequencies)
	held.Segment.PostingFields = uint16sOf(file.PostingFields)
	if file.TracksPositions {
		held.PositionOffsets = valuesOf(file.PositionOffsets)
		held.PositionValues = valuesOf(file.Positions)
	}
	held.Segment.RemovalIndex = buildRemovalIndex(&held.Segment)
	held.Segment.ExactSlots = core.ExactTermSlots(&held.Segment.Terms)
	return held
}

func derivedFieldIndexes(w *core.Workspace, file *keyword.Segment) (FrozenFields, error) {
	wrapped, err := fileFieldIndexes(file)
	if err != nil {
		return FrozenFields{}, err
	}
	return mergeFieldSets(w, []*FrozenFields{wrapped}, frozenStored,
		[][]uint32{identitySlots(int(file.DocumentCount))}, file.DocumentCount)
}

func OpenKeywordFile(w *core.Workspace, file *keyword.Segment) (*Frozen, error) {
	if file == nil || file.DocumentCount == 0 {
		return nil, fmt.Errorf("%w: a frozen segment needs a keyword file that holds a document", ErrInvalidInput)
	}
	derived, err := derivedFieldIndexes(w, file)
	if err != nil {
		return nil, err
	}
	return &Frozen{Keyword: fileKeyword(file), Fields: derived}, nil
}
