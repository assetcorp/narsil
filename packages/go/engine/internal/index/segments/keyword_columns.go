package segments

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

type keywordColumns struct {
	fieldNames     []string
	tokens         []byte
	tokenOffsets   keyword.Uint32s
	frequencies    keyword.Uint32s
	postingOffsets keyword.Uint32s
	fieldLengths   []keyword.FieldLengthColumn
	surfaces       *keyword.SurfaceFormColumn
	partialWords   *keyword.PartialWordColumn
	documentCount  uint32
}

func (k *Keyword) holdFieldLengths(columns []keyword.FieldLengthColumn) {
	count := k.Segment.DocumentCount
	k.FieldLengths = make([][]uint32, len(k.FieldNames))
	k.TotalFieldLengths = make([]float64, len(k.FieldNames))
	for field := range k.FieldNames {
		k.FieldLengths[field] = make([]uint32, count)
	}
	for _, column := range columns {
		field := slices.Index(k.FieldNames, column.Field)
		if field < 0 || column.Lengths.Len() != int(count) {
			continue
		}
		k.FieldLengths[field] = valuesOf(column.Lengths)
		for _, length := range k.FieldLengths[field] {
			k.TotalFieldLengths[field] += float64(length)
		}
	}
}

func (k *Keyword) holdSurfaces(surfaces *keyword.SurfaceFormColumn) {
	if surfaces == nil || surfaces.Counts.Len() == 0 {
		return
	}
	k.Segment.Surfaces = &core.FrozenStrings{Text: surfaces.Text, Offsets: valuesOf(surfaces.Offsets),
		Counts: valuesOf(surfaces.Counts)}
}

func (k *Keyword) holdPartialWords(partial *keyword.PartialWordColumn) {
	if partial == nil {
		return
	}
	k.PartialFieldNames = slices.Clone(partial.Fields)
	for field, name := range k.FieldNames {
		if slices.Contains(partial.Fields, name) {
			k.Segment.PartialFields[field] = 1
		}
	}
	k.Segment.Spellings = &core.FrozenStrings{Text: partial.Text, Offsets: valuesOf(partial.Offsets),
		Counts: valuesOf(partial.Counts)}
	k.Segment.SpellingTokens = valuesOf(partial.Tokens)
	k.SpellingRuns = core.FrozenSpellingRuns{Points: valuesOf(partial.Runs), Offsets: valuesOf(partial.RunOffsets),
		Members: valuesOf(partial.RunEntries)}
}

func heldKeyword(columns keywordColumns) Keyword {
	names := slices.Clone(columns.fieldNames)
	terms := core.FrozenStrings{Text: columns.tokens, Offsets: valuesOf(columns.tokenOffsets),
		Counts: valuesOf(columns.frequencies)}
	held := Keyword{
		Segment: core.FrozenSegment{
			Terms:          terms,
			PayloadSlots:   identitySlots(len(terms.Counts)),
			PostingOffsets: valuesOf(columns.postingOffsets),
			PartialFields:  make([]uint8, len(names)),
			DocumentCount:  columns.documentCount,
		},
		FieldNames: names,
	}
	held.holdFieldLengths(columns.fieldLengths)
	held.holdSurfaces(columns.surfaces)
	held.holdPartialWords(columns.partialWords)
	return held
}
