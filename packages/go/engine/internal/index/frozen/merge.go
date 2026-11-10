package frozen

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/stored"
)

type MergeInput struct {
	Segment  *Segment
	Removed  bitset.Bits
	Surfaces []SurfaceForm
}

type mergeRemap struct {
	input  MergeInput
	remap  []int32
	fields []uint16
}

type tokenCursor struct {
	input *mergeRemap
	at    int
}

func fieldNumberIn(names *[]string, name string) uint16 {
	for at, held := range *names {
		if held == name {
			return uint16(at)
		}
	}
	*names = append(*names, name)
	return uint16(len(*names) - 1)
}

func MergedDocuments(inputs []MergeInput) ([]*stored.Document, error) {
	var documents []*stored.Document
	for _, input := range inputs {
		for ordinal := range input.Segment.DocumentCount() {
			if input.Removed.Has(uint32(ordinal)) {
				continue
			}
			document, err := input.Segment.DocumentAt(uint32(ordinal))
			if err != nil {
				return nil, err
			}
			documents = append(documents, document)
		}
	}
	return documents, nil
}

func MergeRemaps(inputs []MergeInput) [][]int32 {
	remaps := make([][]int32, len(inputs))
	next := int32(0)
	for at, input := range inputs {
		remap := make([]int32, input.Segment.DocumentCount())
		for ordinal := range remap {
			remap[ordinal] = -1
			if !input.Removed.Has(uint32(ordinal)) {
				remap[ordinal] = next
				next++
			}
		}
		remaps[at] = remap
	}
	return remaps
}

func mergePatterns(inputs []MergeInput, remaps [][]int32) []pattern.Arrays {
	byField := map[string][]pattern.MergeInput{}
	var fields []string
	for at, input := range inputs {
		for _, field := range input.Segment.PatternFields() {
			if _, seen := byField[field]; !seen {
				fields = append(fields, field)
			}
			index := input.Segment.patterns[field]
			byField[field] = append(byField[field], pattern.MergeInput{Arrays: index.Arrays(field), Remap: remaps[at]})
		}
	}
	merged := make([]pattern.Arrays, 0, len(fields))
	for _, field := range fields {
		merged = append(merged, pattern.Merge(field, byField[field]))
	}
	return merged
}

func Merge(inputs []MergeInput, documents []*stored.Document, indexes FieldIndexes, partial *partialwords.EncodedSpellings) (
	*Segment, error) {
	var fieldNames []string
	remaps := make([]*mergeRemap, len(inputs))
	ordinalRemaps := MergeRemaps(inputs)
	tracksPositions := false
	for at, input := range inputs {
		held := &mergeRemap{input: input, remap: ordinalRemaps[at]}
		held.fields = make([]uint16, len(input.Segment.fieldNames))
		for field, name := range input.Segment.fieldNames {
			held.fields[field] = fieldNumberIn(&fieldNames, name)
		}
		tracksPositions = tracksPositions || input.Segment.TracksPositions()
		remaps[at] = held
	}
	builder := NewBuilder(documents, fieldNames, tracksPositions)
	var failure error
	walkMergedTokens(remaps, func(token string, cursors []*tokenCursor) {
		if failure != nil {
			return
		}
		builder.BeginToken(token)
		for _, cursor := range cursors {
			if err := copyKeptRows(builder, cursor); err != nil {
				failure = err
				return
			}
		}
	})
	if failure != nil {
		return nil, failure
	}
	names, columns := mergeLengths(remaps, len(documents))
	return builder.Finish(Parts{LengthNames: names, LengthColumns: columns, Indexes: indexes, Surfaces: mergeSurfaces(inputs),
		PartialSpellings: partial, Patterns: mergePatterns(inputs, ordinalRemaps)}), nil
}

func walkMergedTokens(remaps []*mergeRemap, visit func(token string, cursors []*tokenCursor)) {
	cursors := make([]*tokenCursor, 0, len(remaps))
	for _, held := range remaps {
		if held.input.Segment.TokenCount() > 0 {
			cursors = append(cursors, &tokenCursor{input: held})
		}
	}
	matching := make([]*tokenCursor, 0, len(cursors))
	for len(cursors) > 0 {
		smallest := cursors[0].input.input.Segment.TokenAt(cursors[0].at)
		for _, cursor := range cursors[1:] {
			if candidate := cursor.input.input.Segment.TokenAt(cursor.at); candidate < smallest {
				smallest = candidate
			}
		}
		matching = matching[:0]
		kept := cursors[:0]
		for _, cursor := range cursors {
			segment := cursor.input.input.Segment
			if segment.TokenAt(cursor.at) != smallest {
				kept = append(kept, cursor)
				continue
			}
			matching = append(matching, &tokenCursor{input: cursor.input, at: cursor.at})
			cursor.at++
			if cursor.at < segment.TokenCount() {
				kept = append(kept, cursor)
			}
		}
		cursors = kept
		visit(smallest, matching)
	}
}

func copyKeptRows(builder *Builder, cursor *tokenCursor) error {
	segment := cursor.input.input.Segment
	remap := cursor.input.remap
	if segment.text != nil {
		list, err := segment.pagedList(cursor.at, 0, 0)
		if err != nil {
			return err
		}
		for row, ordinal := range list.DocIDs {
			if int(ordinal) >= len(remap) || int(list.Fields[row]) >= len(cursor.input.fields) {
				continue
			}
			if target := remap[ordinal]; target >= 0 {
				builder.AddRow(uint32(target), list.Frequencies[row], cursor.input.fields[list.Fields[row]], list.PositionsAt(row))
			}
		}
		return nil
	}
	from, to := segment.postingOffsets[cursor.at], segment.postingOffsets[cursor.at+1]
	for row := from; row < to; row++ {
		target := remap[segment.postingDocuments[row]]
		if target < 0 {
			continue
		}
		var positions []uint32
		if segment.positionOffsets != nil {
			positions = segment.positions[segment.positionOffsets[row]:segment.positionOffsets[row+1]]
		}
		builder.AddRow(uint32(target), segment.postingFrequencies[row], cursor.input.fields[segment.postingFields[row]], positions)
	}
	return nil
}

func mergeLengths(remaps []*mergeRemap, documentCount int) ([]string, [][]uint32) {
	var names []string
	var columns [][]uint32
	for _, held := range remaps {
		segment := held.input.Segment
		for field, name := range segment.lengthNames {
			at := -1
			for existing, known := range names {
				if known == name {
					at = existing
				}
			}
			if at < 0 {
				at = len(names)
				names = append(names, name)
				columns = append(columns, make([]uint32, documentCount))
			}
			for ordinal, length := range segment.lengthColumns[field] {
				if target := held.remap[ordinal]; target >= 0 {
					columns[at][target] = length
				}
			}
		}
	}
	return names, columns
}

func mergeSurfaces(inputs []MergeInput) []SurfaceForm {
	bySurface := map[string]int{}
	var merged []SurfaceForm
	for _, input := range inputs {
		for _, form := range input.Surfaces {
			if form.Occurrences <= 0 {
				continue
			}
			if at, held := bySurface[form.Surface]; held {
				merged[at].Occurrences += form.Occurrences
				continue
			}
			bySurface[form.Surface] = len(merged)
			merged = append(merged, form)
		}
	}
	return merged
}
