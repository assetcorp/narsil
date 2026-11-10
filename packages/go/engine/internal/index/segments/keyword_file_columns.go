package segments

import (
	"encoding/binary"
	"math"
	"math/bits"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

func float64Column(values []float64) keyword.Float64s {
	column := make([]byte, 0, len(values)*8)
	for _, value := range values {
		column = binary.LittleEndian.AppendUint64(column, math.Float64bits(value))
	}
	return column
}

func orderedByPath[T any](entries []Field[T]) []Field[T] {
	ordered := slices.Clone(entries)
	slices.SortStableFunc(ordered, func(left, right Field[T]) int { return strings.Compare(left.Path, right.Path) })
	return ordered
}

func markedOrdinals(words []uint32) keyword.Uint32s {
	var ordinals []uint32
	for at, word := range words {
		for word != 0 {
			ordinals = append(ordinals, uint32(at)<<5|uint32(bits.TrailingZeros32(word)))
			word &= word - 1
		}
	}
	return uint32Column(ordinals)
}

func EnumValues(index *core.EnumIndex) []string {
	values := make([]string, 0, max(0, len(index.Offsets)-1))
	for at := 0; at+1 < len(index.Offsets); at++ {
		values = append(values, string(utf16.Decode(index.Units[index.Offsets[at]:index.Offsets[at+1]])))
	}
	return values
}

func valueColumns(entries []Field[*core.NumericIndex]) []keyword.ValueColumn {
	columns := make([]keyword.ValueColumn, 0, len(entries))
	for _, entry := range orderedByPath(entries) {
		columns = append(columns, keyword.ValueColumn{Field: entry.Path, Documents: uint32Column(entry.Index.Ordinals),
			Values: float64Column(entry.Index.Values)})
	}
	return columns
}

func (set *FieldSet[S]) fillFileColumns(built *keyword.Segment) {
	built.Numeric = valueColumns(set.Numeric)
	built.Sizes = valueColumns(set.Sizes)
	for _, entry := range orderedByPath(set.Boolean) {
		built.Boolean = append(built.Boolean, keyword.BooleanColumn{Field: entry.Path,
			TrueDocuments: markedOrdinals(entry.Index.TrueBits), FalseDocuments: markedOrdinals(entry.Index.FalseBits)})
	}
	for _, entry := range orderedByPath(set.Enum) {
		built.Enum = append(built.Enum, keyword.EnumColumn{Field: entry.Path, Values: EnumValues(entry.Index),
			Offsets: uint32Column(entry.Index.PostingOffsets), Documents: uint32Column(entry.Index.Postings)})
	}
	for _, entry := range orderedByPath(set.Geo) {
		built.Geopoint = append(built.Geopoint, keyword.GeopointColumn{Field: entry.Path,
			Documents: uint32Column(entry.Index.Ordinals), Latitudes: float64Column(entry.Index.Lat),
			Longitudes: float64Column(entry.Index.Lon)})
	}
	for _, entry := range orderedByPath(set.Pattern) {
		built.Pattern = append(built.Pattern, keyword.PatternColumn{Field: entry.Path,
			Documents: uint32Column(entry.Index.Documents), Runs: uint32Column(entry.Index.Runs),
			Offsets: uint32Column(entry.Index.Offsets), Postings: uint32Column(entry.Index.Postings)})
	}
}
