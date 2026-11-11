package segment

import (
	"fmt"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type StreamedInput struct {
	Source   segments.Source
	Paged    *segments.Paged
	Document func(ordinal uint32) (string, []byte, error)
}

type mergedInput struct {
	StreamedInput
	keyword   *segments.Keyword
	mapping   []uint32
	template  core.KeywordMergeInput
	surfaces  *core.FrozenStrings
	spellings *core.FrozenStrings
	read      pagedRows
}

type streamedMerge struct {
	inputs          []mergedInput
	documentCount   uint32
	fieldNames      []string
	partialNames    []string
	lengthNames     []string
	lengths         *core.KeywordMergeOutput
	tracksPositions bool
	keepsRecords    bool
}

func unionIndex(names *[]string, name string) int {
	if at := slices.Index(*names, name); at >= 0 {
		return at
	}
	*names = append(*names, name)
	return len(*names) - 1
}

func emptyMergeInput(mapping []uint32) core.KeywordMergeInput {
	return core.KeywordMergeInput{Terms: core.FrozenStrings{Offsets: []uint32{0}}, PostingOffsets: []uint32{0},
		Mapping: mapping, DocumentCount: uint32(len(mapping))}
}

func (merge *streamedMerge) addInput(w *core.Workspace, input StreamedInput, count *uint64) error {
	surfaces, spellings, err := input.Source.MergeStrings(w)
	if err != nil {
		return err
	}
	held := mergedInput{StreamedInput: input, keyword: &input.Source.Frozen.Keyword, surfaces: surfaces,
		spellings: spellings}
	held.mapping = make([]uint32, input.Source.Frozen.DocumentCount())
	for ordinal := range held.mapping {
		held.mapping[ordinal] = core.MergeDroppedOrdinal
		if input.Source.Keeps(uint32(ordinal)) {
			held.mapping[ordinal] = uint32(*count)
			*count++
		}
	}
	if *count >= core.MergeDroppedOrdinal {
		return segments.ErrSegmentFull
	}
	held.template = emptyMergeInput(held.mapping)
	held.template.FieldMapping = make([]uint16, len(held.keyword.FieldNames))
	held.template.FieldLengths = make([][]uint32, len(held.keyword.FieldNames))
	for field, name := range held.keyword.FieldNames {
		held.template.FieldMapping[field] = uint16(unionIndex(&merge.fieldNames, name))
	}
	for _, name := range held.keyword.PartialFieldNames {
		unionIndex(&merge.partialNames, name)
	}
	if len(merge.fieldNames) > core.MaxSegmentFields {
		return fmt.Errorf("%w: the merge holds more than %d fields", segments.ErrInvalidInput, core.MaxSegmentFields)
	}
	if input.Paged != nil {
		merge.tracksPositions = merge.tracksPositions || input.Paged.TracksPositions()
		merge.keepsRecords = merge.keepsRecords && input.Paged.HoldsWriteRecords()
	} else {
		merge.tracksPositions = merge.tracksPositions || held.keyword.PositionOffsets != nil
		merge.keepsRecords = false
	}
	merge.inputs = append(merge.inputs, held)
	return nil
}

func prepareMerge(w *core.Workspace, inputs []StreamedInput) (*streamedMerge, error) {
	for _, input := range inputs {
		if input.Paged == nil {
			continue
		}
		if err := input.Paged.RequirePayloadChecksum(); err != nil {
			return nil, err
		}
	}
	merge := &streamedMerge{keepsRecords: len(inputs) > 0}
	var count uint64
	for _, input := range inputs {
		if err := merge.addInput(w, input, &count); err != nil {
			return nil, err
		}
	}
	merge.documentCount = uint32(count)
	return merge, merge.mergeLengths(w)
}

func (merge *streamedMerge) mergeLengths(w *core.Workspace) error {
	if len(merge.inputs) == 0 {
		return nil
	}
	request := &core.KeywordMergeRequest{DocumentCount: merge.documentCount}
	for _, input := range merge.inputs {
		source := emptyMergeInput(input.mapping)
		for field, name := range input.keyword.FieldNames {
			if field >= len(input.keyword.FieldLengths) || len(input.keyword.FieldLengths[field]) == 0 {
				continue
			}
			source.FieldLengths = append(source.FieldLengths, input.keyword.FieldLengths[field])
			source.FieldMapping = append(source.FieldMapping, uint16(unionIndex(&merge.lengthNames, name)))
		}
		request.Inputs = append(request.Inputs, source)
	}
	request.FieldCount = uint32(len(merge.lengthNames))
	var err error
	merge.lengths, err = segments.MergeKeywordSources(w, request)
	return err
}

func (merge *streamedMerge) lengthColumn(at int) []uint32 {
	start := uint64(at) * uint64(merge.documentCount)
	return merge.lengths.FieldLengths[start : start+uint64(merge.documentCount)]
}

func (merge *streamedMerge) fieldLengthColumns() []keyword.FieldLengthColumn {
	columns := make([]keyword.FieldLengthColumn, len(merge.lengthNames))
	for at, name := range merge.lengthNames {
		columns[at] = keyword.FieldLengthColumn{Field: name, Lengths: keyword.Uint32sOf(merge.lengthColumn(at)...)}
	}
	return columns
}

func (merge *streamedMerge) lengthColumnsByField() [][]uint32 {
	columns := make([][]uint32, len(merge.fieldNames))
	for field, name := range merge.fieldNames {
		if at := slices.Index(merge.lengthNames, name); at >= 0 {
			columns[field] = merge.lengthColumn(at)
		}
	}
	return columns
}

func (merge *streamedMerge) mergeStrings(w *core.Workspace, terms core.FrozenStrings) (*keyword.SurfaceFormColumn,
	*keyword.PartialWordColumn, error) {
	if len(merge.inputs) == 0 {
		return nil, nil, nil
	}
	request := &core.KeywordMergeRequest{DocumentCount: merge.documentCount, RetainedTerms: &terms}
	for _, input := range merge.inputs {
		source := emptyMergeInput(input.mapping)
		source.Surfaces, source.Spellings = input.surfaces, input.spellings
		request.Inputs = append(request.Inputs, source)
	}
	output, err := segments.MergeKeywordSources(w, request)
	if err != nil {
		return nil, nil, err
	}
	var surfaces *keyword.SurfaceFormColumn
	if len(output.Surfaces.Counts) > 0 {
		surfaces = &keyword.SurfaceFormColumn{Text: output.Surfaces.Text,
			Offsets: keyword.Uint32sOf(output.Surfaces.Offsets...), Counts: keyword.Uint32sOf(output.Surfaces.Counts...)}
	}
	return surfaces, segments.PartialWordColumn(merge.partialNames, &output.Spellings, &terms), nil
}

func (merge *streamedMerge) mergeFieldColumns(w *core.Workspace) (*keyword.Segment, error) {
	if len(merge.inputs) == 0 {
		return &keyword.Segment{}, nil
	}
	sets := make([]*segments.FrozenFields, len(merge.inputs))
	mappings := make([][]uint32, len(merge.inputs))
	for at := range merge.inputs {
		sets[at] = &merge.inputs[at].Source.Frozen.Fields
		mappings[at] = merge.inputs[at].mapping
	}
	return segments.MergeFieldColumns(w, sets, mappings, merge.documentCount)
}
