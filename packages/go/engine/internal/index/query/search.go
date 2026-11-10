package query

import (
	"context"
	"errors"
	"math"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type searcher struct {
	workspace    *core.Workspace
	finder       termFinder
	terms        exactTerms
	builder      requestBuilder
	fields       fieldScoring
	averages     []float64
	members      []plannedMember
	combineLists []postingList
	combined     rowColumns
	rowOfField   []int32
	work         *Work
	ownWork      bool
	paged        pagedPool
}

var searchers = sync.Pool{New: func() any { return &searcher{} }}

func acquireSearcher() (*searcher, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	s := searchers.Get().(*searcher)
	s.workspace = workspace
	return s, nil
}

func (s *searcher) release() {
	s.paged.reset(nil)
	s.builder.release()
	if s.ownWork {
		s.work.Close()
	}
	s.work, s.ownWork = nil, false
	s.workspace.Release()
	s.workspace = nil
	searchers.Put(s)
}

func (s *searcher) useWork(query *KeywordQuery) {
	s.work = query.Work
	if s.work == nil && len(query.Phrases) > 0 {
		s.work, s.ownWork = NewWork(context.Background(), DefaultPatternWorkCap), true
	}
}

func validateView(view *View) error {
	if view == nil {
		return narsilerr.New(narsilerr.CodePartitionCorrupted, "The partition view is missing", nil)
	}
	for index := range view.Segments {
		segment := &view.Segments[index]
		if !segment.valid() || !segment.headersHeld() {
			return narsilerr.New(narsilerr.CodePartitionCorrupted, "A segment of the partition view holds neither a growing nor a frozen segment", map[string]any{"segment": index})
		}
		if segment.Growing == nil && segment.State.PendingHeader[core.PendingDocuments] != 0 {
			return narsilerr.New(narsilerr.CodePartitionCorrupted, "A frozen segment state holds removals that no writer settled", map[string]any{"segment": index})
		}
		if !segment.holdsFields(len(view.FieldNames)) {
			return narsilerr.New(narsilerr.CodePartitionCorrupted, "A segment of the partition view holds fewer field lengths than the view names", map[string]any{"segment": index, "fields": len(view.FieldNames)})
		}
	}
	return nil
}

func onlyPopulated(view *View) int {
	found := -1
	for index := range view.Segments {
		if view.Segments[index].liveDocuments() == 0 {
			continue
		}
		if found != -1 {
			return -1
		}
		found = index
	}
	return found
}

func Search(view *View, query *KeywordQuery) (*KeywordResult, error) {
	if err := validateView(view); err != nil {
		return nil, err
	}
	if err := validatePhrases(query.Phrases); err != nil {
		return nil, err
	}
	result := &KeywordResult{}
	if query.Collect == MatchedOrdinals {
		result.Matched = make([][]uint32, len(view.Segments))
	}
	if len(query.Tokens) == 0 && len(query.Phrases) == 0 {
		return result, nil
	}
	s, err := acquireSearcher()
	if err != nil {
		return nil, err
	}
	defer s.release()
	s.useWork(query)
	s.terms.reset()
	s.terms.addQuery(query)
	if single := onlyPopulated(view); single != -1 {
		stats := s.singleStatistics(view, &view.Segments[single], query)
		hits, err := s.searchSegment(view, single, query, stats, result)
		if err != nil {
			return nil, err
		}
		result.Hits = hits
		return result, nil
	}
	stats, err := s.compositeStatistics(view, query)
	if err != nil {
		return nil, err
	}
	lists := make([][]Hit, len(view.Segments))
	for index := range view.Segments {
		if lists[index], err = s.searchSegment(view, index, query, stats, result); err != nil {
			return nil, err
		}
	}
	limit := uint64(math.MaxUint32)
	if query.HasLimit {
		limit = uint64(max(0, query.Limit))
	}
	merged, err := MergeHits(s.workspace, lists, query.Order, limit)
	if err != nil {
		return nil, err
	}
	result.Hits = merged
	return result, nil
}

func refusal(err error) error {
	if _, coded := narsilerr.As(err); coded {
		return err
	}
	switch core.StatusOf(err) {
	case core.StatusOK:
		return err
	case core.StatusWorkCapExceeded:
		return narsilerr.Wrap(narsilerr.CodeSearchWorkCapExceeded, "The search exceeded its work cap", err, nil)
	case core.StatusStopped:
		return ErrStopped
	}
	return narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The native search core refused the search", err, nil)
}

func (s *searcher) refusal(err error) error {
	if core.StatusOf(err) == core.StatusWorkCapExceeded && s.work != nil {
		if meter := s.work.opened(); meter != nil {
			return patternWorkCapExceeded(meter.Cap())
		}
	}
	return refusal(err)
}

var ErrStopped = errors.New("the search was stopped before it finished")

func (s *searcher) searchSegment(view *View, index int, query *KeywordQuery, stats *scoringStatistics, result *KeywordResult) ([]Hit, error) {
	segment := &view.Segments[index]
	capacity := segment.capacity()
	filter, hasFilter := query.filterOf(index)
	if hasFilter && len(filter) < bitsetWords(capacity) {
		return nil, nil
	}
	s.fields.load(view.FieldNames, query, stats.averages)
	var phrases *phraseMatches
	if len(query.Phrases) > 0 {
		matched, err := s.matchPhrases(segment, query, s.fields.searchable, filter, hasFilter)
		if err != nil {
			return nil, s.refusal(err)
		}
		if bitsetEmpty(matched.matched) {
			return nil, nil
		}
		phrases, filter, hasFilter = matched, matched.matched, true
	}
	s.builder.begin(segment)
	request := &s.builder.request
	s.fields.apply(request, segment)
	if err := s.planTerms(segment, query, stats); err != nil {
		return nil, s.refusal(err)
	}
	if phrases != nil {
		if err := s.planPhrases(segment, query, stats, phrases); err != nil {
			return nil, err
		}
	}
	request.PoolDocIDs, request.PoolFrequencies, request.PoolFields = s.poolOf(segment)
	request.HasFilter, request.Filter = hasFilter, filter
	live, err := segment.liveBits()
	if err != nil {
		return nil, err
	}
	request.Live = live
	request.Removed = segment.removed()
	request.Terms = float64(len(query.Tokens))
	request.Capacity = capacity
	request.TotalDocuments = stats.totalDocuments
	request.TermMatch = float64(query.TermMatch)
	request.Limit = core.KeywordNoLimit
	if query.HasLimit {
		request.Limit = float64(max(0, query.Limit))
	}
	request.MinScore = query.MinScore
	request.Collect = query.Collect != MatchedNone
	output := s.builder.sizeOutput(capacity)
	outcome, err := s.workspace.KeywordScore(request, output)
	if err != nil {
		return nil, s.refusal(err)
	}
	count := min(int(outcome.Count), len(output.Ordinals))
	var components map[uint32]*model.ScoreComponents
	if query.Components {
		components = keywordComponents(&s.builder, view.FieldNames, output.Ordinals[:count])
	}
	hits := make([]Hit, count)
	for at := range count {
		ordinal := uint32(output.Ordinals[at])
		hits[at] = Hit{Segment: index, Ordinal: ordinal, Score: output.Scores[at], Components: components[ordinal]}
	}
	orderTiedHits(hits, query.Order)
	if query.HasLimit && len(hits) > query.Limit {
		hits = hits[:max(0, query.Limit)]
	}
	result.TotalMatched += int(outcome.TotalMatched)
	if result.Matched != nil {
		result.Matched[index] = append([]uint32(nil), output.Matched[:bitsetWords(capacity)]...)
	}
	return hits, nil
}
