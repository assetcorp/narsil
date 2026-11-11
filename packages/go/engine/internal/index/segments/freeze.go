package segments

import (
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type GrowingInput struct {
	Segment           *core.GrowingSegment
	FieldNames        []string
	PartialFieldNames []string
	Mapping           []uint32
	Fields            *GrowingFields
}

func keptCount(mapping []uint32) (uint32, error) {
	var count uint64
	for _, target := range mapping {
		if target != core.MergeDroppedOrdinal {
			count++
		}
	}
	if count >= core.MergeDroppedOrdinal {
		return 0, ErrInvalidInput
	}
	return uint32(count), nil
}

func mergeRefusal(err error) error {
	if core.StatusOf(err) == core.StatusSegmentFull {
		return fmt.Errorf("%w: %w", ErrSegmentFull, err)
	}
	return err
}

func runKeywordMerge(w *core.Workspace, request *core.KeywordMergeRequest) (*core.KeywordMergeOutput, error) {
	sizes, err := w.MeasureMerge(request)
	if err != nil {
		return nil, mergeRefusal(err)
	}
	output := core.NewKeywordMergeOutput(sizes, request.DocumentCount, request.FieldCount)
	if err := w.WriteMerge(request, output); err != nil {
		return nil, mergeRefusal(err)
	}
	return output, nil
}

func (input *GrowingInput) keywordInput() (core.KeywordMergeInput, error) {
	segment := input.Segment
	if segment == nil || len(input.FieldNames) != len(segment.PartialFields) ||
		uint64(len(input.Mapping)) > uint64(segment.OrdinalCapacity) {
		return core.KeywordMergeInput{}, ErrInvalidInput
	}
	surfaces, err := growingPairs(segment.Surfaces, &segment.Terms)
	if err != nil {
		return core.KeywordMergeInput{}, err
	}
	var spellings *core.FrozenStrings
	if segment.Spellings != nil {
		if spellings, err = growingPairs(&segment.Spellings.Entries, &segment.Terms); err != nil {
			return core.KeywordMergeInput{}, err
		}
	}
	fields := len(input.FieldNames)
	capacity := uint64(segment.OrdinalCapacity)
	if uint64(len(segment.FieldLengths)) != uint64(fields)*capacity {
		return core.KeywordMergeInput{}, ErrInvalidInput
	}
	lengths := make([][]uint32, fields)
	mapping := make([]uint16, fields)
	for field := range fields {
		start := uint64(field) * capacity
		lengths[field] = segment.FieldLengths[start : start+uint64(len(input.Mapping))]
		mapping[field] = uint16(field)
	}
	return core.KeywordMergeInput{
		Growing:       segment,
		Mapping:       input.Mapping,
		FieldMapping:  mapping,
		FieldLengths:  lengths,
		DocumentCount: uint32(len(input.Mapping)),
		Surfaces:      surfaces,
		Spellings:     spellings,
	}, nil
}

func Freeze(w *core.Workspace, input GrowingInput) (*Frozen, error) {
	count, err := keptCount(input.Mapping)
	if err != nil {
		return nil, err
	}
	source, err := input.keywordInput()
	if err != nil {
		return nil, err
	}
	request := &core.KeywordMergeRequest{
		Inputs:        []core.KeywordMergeInput{source},
		DocumentCount: count,
		FieldCount:    uint32(len(input.FieldNames)),
	}
	output, err := runKeywordMerge(w, request)
	if err != nil {
		return nil, err
	}
	partial := append([]uint8(nil), input.Segment.PartialFields...)
	keyword := keywordFrom(output, count, input.FieldNames, input.PartialFieldNames, partial)
	fields, err := mergeFieldSets(w, []*GrowingFields{input.Fields}, growingStored, [][]uint32{input.Mapping}, count)
	if err != nil {
		return nil, err
	}
	return &Frozen{Keyword: keyword, Fields: fields}, nil
}

func keywordFrom(output *core.KeywordMergeOutput, documents uint32, fieldNames, partialNames []string,
	partial []uint8) Keyword {
	segment := core.FrozenSegment{
		Terms:              output.Terms,
		PayloadSlots:       identitySlots(len(output.Terms.Counts)),
		PostingOffsets:     output.PostingOffsets,
		PostingDocuments:   output.PostingDocuments,
		PostingFrequencies: output.PostingFrequencies,
		PostingFields:      output.PostingFields,
		Surfaces:           nonEmpty(output.Surfaces),
		PartialFields:      partial,
		DocumentCount:      documents,
	}
	keyword := Keyword{
		FieldNames:        append([]string(nil), fieldNames...),
		PartialFieldNames: append([]string(nil), partialNames...),
		TotalFieldLengths: output.TotalFieldLengths,
		PositionOffsets:   output.PositionOffsets,
		PositionValues:    output.PositionValues,
		FieldLengths:      make([][]uint32, len(fieldNames)),
	}
	for field := range fieldNames {
		start := uint64(field) * uint64(documents)
		keyword.FieldLengths[field] = output.FieldLengths[start : start+uint64(documents)]
	}
	if len(partialNames) > 0 {
		table := splitSpellings(&output.Spellings, &output.Terms)
		segment.Spellings = table.spellings
		segment.SpellingTokens = table.tokens
		keyword.SpellingRuns = table.runs
	}
	segment.RemovalIndex = buildRemovalIndex(&segment)
	segment.ExactSlots = core.ExactTermSlots(&segment.Terms)
	keyword.Segment = segment
	return keyword
}
