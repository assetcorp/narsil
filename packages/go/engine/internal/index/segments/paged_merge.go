package segments

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

func (p *Paged) TracksPositions() bool {
	return p.reader.Resident.TracksPositions
}

func (p *Paged) HoldsWriteRecords() bool {
	_, seqNos := p.reader.Head.Section("seqNos")
	_, primaryTerms := p.reader.Head.Section("primaryTerms")
	return seqNos && primaryTerms
}

func (p *Paged) WriteRecord(ordinal uint32) (uint64, uint64, error) {
	seqNo, primaryTerm, _, err := p.reader.WriteRecord(ordinal)
	return seqNo, primaryTerm, err
}

func (p *Paged) IDAt(ordinal uint32) (string, error) {
	id, err := p.reader.IDBytes(ordinal)
	return string(id), err
}

func (p *Paged) SortedOrdinal(position uint32) (uint32, error) {
	return p.reader.SortedOrdinal(position)
}

func (p *Paged) RequirePayloadChecksum() error {
	if p.payloadChecked.Load() {
		return nil
	}
	if err := p.reader.RequirePayloadChecksum(); err != nil {
		return err
	}
	p.payloadChecked.Store(true)
	return nil
}

func (s *Source) Keeps(ordinal uint32) bool {
	return s.keeps(ordinal)
}

func (s *Source) MergeStrings(w *core.Workspace) (*core.FrozenStrings, *core.FrozenStrings, error) {
	if err := s.check(); err != nil {
		return nil, nil, err
	}
	surfaces, spellings, err := s.removedStrings(w)
	if err != nil {
		return nil, nil, err
	}
	segment := &s.Frozen.Keyword.Segment
	return residentPairs(segment.Surfaces, surfaces), spellingPairs(segment, spellings), nil
}

func MergeKeywordSources(w *core.Workspace, request *core.KeywordMergeRequest) (*core.KeywordMergeOutput, error) {
	return runKeywordMerge(w, request)
}

func MergePostings(w *core.Workspace, request *core.KeywordMergeRequest, output *core.PostingMergeOutput) (uint32,
	error) {
	count, err := w.MergePostings(request, output)
	return count, mergeRefusal(err)
}

func MergeFieldColumns(w *core.Workspace, sets []*FrozenFields, mappings [][]uint32, count uint32) (*keyword.Segment,
	error) {
	merged, err := mergeFieldSets(w, sets, frozenStored, mappings, count)
	if err != nil {
		return nil, err
	}
	columns := &keyword.Segment{DocumentCount: count}
	merged.fillFileColumns(columns)
	return columns, nil
}

func PartialWordColumn(partialNames []string, spellings *core.FrozenStrings,
	terms *core.FrozenStrings) *keyword.PartialWordColumn {
	if len(partialNames) == 0 {
		return nil
	}
	table := splitSpellings(spellings, terms)
	held := Keyword{PartialFieldNames: partialNames, SpellingRuns: table.runs,
		Segment: core.FrozenSegment{Spellings: table.spellings, SpellingTokens: table.tokens}}
	return held.partialColumn()
}
