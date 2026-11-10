package segments

import (
	"errors"
	"fmt"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type Source struct {
	Segment int
	Frozen  *Frozen
	State   *State
	Keep    func(ordinal uint32) bool
	Tokens  func(ordinal uint32) ([]Tokens, error)
}

type MergeResult struct {
	Frozen   *Frozen
	Segments []int
	Mappings [][]uint32
}

func (s *Source) keeps(ordinal uint32) bool {
	if s.State != nil && s.State.Tombstoned(ordinal) {
		return false
	}
	return s.Keep == nil || s.Keep(ordinal)
}

func (s *Source) check() error {
	if s.Frozen == nil {
		return fmt.Errorf("%w: a merge source holds no frozen segment", ErrInvalidInput)
	}
	if s.State == nil {
		return nil
	}
	if s.State.keyword != &s.Frozen.Keyword {
		return fmt.Errorf("%w: a merge source pairs a state with another segment", ErrInvalidInput)
	}
	if !s.State.Settled() {
		return ErrPendingRemove
	}
	return nil
}

func (s *Source) removedStrings(w *core.Workspace) ([]uint32, []uint32, error) {
	if s.State == nil && s.Keep == nil {
		return nil, nil, nil
	}
	state := s.State
	if s.Keep != nil {
		state = NewState(&s.Frozen.Keyword, nil)
		if s.State != nil {
			state = s.State.Clone()
		}
		for ordinal := range s.Frozen.DocumentCount() {
			if state.Tombstoned(ordinal) || s.Keep(ordinal) {
				continue
			}
			if s.Tokens == nil {
				return nil, nil, ErrMissingTokens
			}
			tokens, err := s.Tokens(ordinal)
			if err != nil {
				return nil, nil, err
			}
			if err := state.Remove(w, ordinal, tokens); err != nil {
				return nil, nil, err
			}
		}
		if err := state.Settle(w); err != nil {
			return nil, nil, err
		}
	}
	return state.Core.RemovedSurfaces, state.Core.RemovedSpellings, nil
}

func (s *Source) mergeInput(w *core.Workspace, mapping []uint32, fieldMapping []uint16) (core.KeywordMergeInput, error) {
	keyword := &s.Frozen.Keyword
	segment := &keyword.Segment
	surfaces, spellings, err := s.removedStrings(w)
	if err != nil {
		return core.KeywordMergeInput{}, err
	}
	lengths := make([][]uint32, len(keyword.FieldNames))
	for field := range lengths {
		if field < len(keyword.FieldLengths) && len(keyword.FieldLengths[field]) > 0 {
			lengths[field] = keyword.FieldLengths[field]
		}
	}
	return core.KeywordMergeInput{
		Terms:              segment.Terms,
		PayloadSlots:       segment.PayloadSlots,
		PostingOffsets:     segment.PostingOffsets,
		PostingDocuments:   segment.PostingDocuments,
		PostingFrequencies: segment.PostingFrequencies,
		PostingFields:      segment.PostingFields,
		PositionOffsets:    keyword.PositionOffsets,
		PositionValues:     keyword.PositionValues,
		Mapping:            mapping,
		FieldMapping:       fieldMapping,
		FieldLengths:       lengths,
		DocumentCount:      segment.DocumentCount,
		Surfaces:           residentPairs(segment.Surfaces, surfaces),
		Spellings:          spellingPairs(segment, spellings),
	}, nil
}

func unionIndex(names *[]string, name string) int {
	if at := slices.Index(*names, name); at >= 0 {
		return at
	}
	*names = append(*names, name)
	return len(*names) - 1
}

func Merge(w *core.Workspace, sources []Source) (*MergeResult, error) {
	if len(sources) == 0 {
		return nil, ErrEmptyMerge
	}
	result := &MergeResult{Segments: make([]int, len(sources)), Mappings: make([][]uint32, len(sources))}
	var count uint64
	var fieldNames, partialNames []string
	fieldMappings := make([][]uint16, len(sources))
	for at := range sources {
		source := &sources[at]
		if err := source.check(); err != nil {
			return nil, err
		}
		mapping := make([]uint32, source.Frozen.DocumentCount())
		for ordinal := range mapping {
			mapping[ordinal] = core.MergeDroppedOrdinal
			if source.keeps(uint32(ordinal)) {
				mapping[ordinal] = uint32(count)
				count++
			}
		}
		if count >= core.MergeDroppedOrdinal {
			return nil, ErrSegmentFull
		}
		result.Segments[at], result.Mappings[at] = source.Segment, mapping
		keyword := &source.Frozen.Keyword
		fieldMappings[at] = make([]uint16, len(keyword.FieldNames))
		for field, name := range keyword.FieldNames {
			fieldMappings[at][field] = uint16(unionIndex(&fieldNames, name))
		}
		for _, name := range keyword.PartialFieldNames {
			unionIndex(&partialNames, name)
		}
		if len(fieldNames) > core.MaxSegmentFields {
			return nil, fmt.Errorf("%w: the merge holds more than %d fields", ErrInvalidInput, core.MaxSegmentFields)
		}
	}
	if count == 0 {
		return nil, ErrEmptyMerge
	}
	request := &core.KeywordMergeRequest{DocumentCount: uint32(count), FieldCount: uint32(len(fieldNames))}
	for at := range sources {
		input, err := sources[at].mergeInput(w, result.Mappings[at], fieldMappings[at])
		if err != nil {
			return nil, err
		}
		request.Inputs = append(request.Inputs, input)
	}
	output, err := runKeywordMerge(w, request)
	if err != nil {
		return nil, err
	}
	partial := make([]uint8, len(fieldNames))
	for field, name := range fieldNames {
		if slices.Contains(partialNames, name) {
			partial[field] = 1
		}
	}
	keyword := keywordFrom(output, uint32(count), fieldNames, partialNames, partial)
	sets := make([]*FrozenFields, len(sources))
	for at := range sources {
		sets[at] = &sources[at].Frozen.Fields
	}
	fields, err := mergeFieldSets(w, sets, frozenStored, result.Mappings, uint32(count))
	if err != nil {
		return nil, err
	}
	result.Frozen = &Frozen{Keyword: keyword, Fields: fields}
	return result, nil
}

func Split(sources []Source) ([2][]Source, error) {
	var count uint64
	for at := range sources {
		if err := sources[at].check(); err != nil {
			return [2][]Source{}, err
		}
		for ordinal := range sources[at].Frozen.DocumentCount() {
			if sources[at].keeps(ordinal) {
				count++
			}
		}
	}
	if count < 2 {
		return [2][]Source{}, ErrUnsplittable
	}
	middle := (count + 1) / 2
	var halves [2][]Source
	var at uint64
	for _, source := range sources {
		marks := make([]uint8, source.Frozen.DocumentCount())
		var first, second bool
		for ordinal := range marks {
			if !source.keeps(uint32(ordinal)) {
				continue
			}
			if at < middle {
				marks[ordinal], first = 1, true
			} else {
				marks[ordinal], second = 2, true
			}
			at++
		}
		if first {
			halves[0] = append(halves[0], source.keeping(marks, 1))
		}
		if second {
			halves[1] = append(halves[1], source.keeping(marks, 2))
		}
	}
	return halves, nil
}

func (s Source) keeping(marks []uint8, mark uint8) Source {
	s.Keep = func(ordinal uint32) bool {
		return uint64(ordinal) < uint64(len(marks)) && marks[ordinal] == mark
	}
	return s
}

func MergeAll(w *core.Workspace, sources []Source) ([]*MergeResult, error) {
	var results []*MergeResult
	pending := [][]Source{sources}
	for len(pending) > 0 {
		selection := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		result, err := Merge(w, selection)
		if err == nil {
			results = append(results, result)
			continue
		}
		if !errors.Is(err, ErrSegmentFull) {
			return nil, err
		}
		halves, err := Split(selection)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrSegmentFull, err)
		}
		pending = append(pending, halves[1], halves[0])
	}
	return results, nil
}

type Policy int

const (
	PolicyIngest Policy = iota
	PolicyIdle
)

func PickInputs(liveCounts []uint32, policy Policy) []int {
	limit := CompactionSegmentTrigger
	if policy == PolicyIdle {
		limit = SegmentsPerMerge
		if len(liveCounts) < 2 {
			return nil
		}
	} else if len(liveCounts) < CompactionSegmentTrigger {
		return nil
	}
	order := make([]int, len(liveCounts))
	for at := range order {
		order[at] = at
	}
	slices.SortStableFunc(order, func(left, right int) int {
		return int(int64(liveCounts[left]) - int64(liveCounts[right]))
	})
	return order[:min(limit, len(order))]
}
