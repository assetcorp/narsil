package vector

import (
	"context"
	"math"
)

func (f *Field) coldView(hold *coldHold) *coldView {
	if view := f.coldViewNow.Load(); view != nil {
		return view
	}
	return &coldView{live: hold.field.LiveCount()}
}

func (h *coldHold) vectorOfIn(view *coldView, docID string) ([]float32, bool) {
	if written, held := view.written[docID]; held {
		return append([]float32(nil), written.values...), true
	}
	if _, removed := view.removedIDs[docID]; removed {
		return nil, false
	}
	number, held := h.field.NumberOf(docID)
	if !held {
		return nil, false
	}
	values, err := h.field.VectorOfNumber(number)
	if err != nil {
		return nil, false
	}
	return values, true
}

func (f *Field) coldVectorOf(hold *coldHold, docID string) ([]float32, bool) {
	defer hold.wantLoad()
	return hold.vectorOfIn(f.coldView(hold), docID)
}

func (f *Field) coldHas(hold *coldHold, docID string) bool {
	view := f.coldView(hold)
	if _, held := view.written[docID]; held {
		return true
	}
	if _, removed := view.removedIDs[docID]; removed {
		return false
	}
	_, held := hold.field.NumberOf(docID)
	return held
}

func coldAdmission(hold *coldHold, filter *Filter) func(docID string) bool {
	if filter == nil {
		return nil
	}
	if filter.byPartitions {
		return func(docID string) bool {
			partition, known := hold.field.PartitionOf(docID)
			if !known {
				return false
			}
			_, wanted := filter.partitions[partition]
			return wanted
		}
	}
	accepted := make(map[string]struct{}, len(filter.docIDs))
	for _, docID := range filter.docIDs {
		accepted[docID] = struct{}{}
	}
	return func(docID string) bool {
		_, held := accepted[docID]
		return held
	}
}

func scanWritten(view *coldView, query []float32, k int, options SearchOptions,
	admits func(docID string) bool) []ScoredResult {
	if len(view.written) == 0 {
		return []ScoredResult{}
	}
	queryMagnitude := magnitudeOf(query)
	tally := newScanTally(max(k, 1))
	for docID, written := range view.written {
		if admits != nil && !admits(docID) {
			continue
		}
		score := plainScore(query, queryMagnitude, written.values, options.Metric)
		if score >= options.MinSimilarity {
			tally.admit(docID, score)
		}
	}
	return tally.results()
}

func scanAcceptedDocIDs(hold *coldHold, view *coldView, query []float32, k int,
	options SearchOptions) SearchOutcome {
	queryMagnitude := magnitudeOf(query)
	tally := newScanTally(max(k, 1))
	for _, docID := range uniqueDocIDs(options.Filter.docIDs) {
		values, held := hold.vectorOfIn(view, docID)
		if !held {
			continue
		}
		score := plainScore(query, queryMagnitude, values, options.Metric)
		if score < options.MinSimilarity {
			continue
		}
		tally.admit(docID, score)
	}
	results := tally.results()
	return SearchOutcome{Results: results[:min(len(results), max(k, 0))], Matched: tally.matched, MatchedExact: true}
}

func uniqueDocIDs(docIDs []string) []string {
	seen := make(map[string]struct{}, len(docIDs))
	unique := make([]string, 0, len(docIDs))
	for _, docID := range docIDs {
		if _, held := seen[docID]; !held {
			seen[docID] = struct{}{}
			unique = append(unique, docID)
		}
	}
	return unique
}

func (f *Field) coldSearch(ctx context.Context, hold *coldHold, query []float32, k int,
	options SearchOptions) (SearchOutcome, error) {
	defer hold.wantLoad()
	view := f.coldView(hold)
	if view.live <= 0 {
		return emptyOutcome(), nil
	}
	admitted := view.live
	if options.Filter != nil && !options.Filter.byPartitions {
		admitted = len(uniqueDocIDs(options.Filter.docIDs))
		if admitted == 0 {
			return emptyOutcome(), nil
		}
		if float64(admitted)/float64(view.live) < f.config.filterThreshold {
			return scanAcceptedDocIDs(hold, view, query, k, options), nil
		}
	}
	if k <= 0 {
		if math.IsInf(options.MinSimilarity, -1) {
			return SearchOutcome{Results: []ScoredResult{}, Matched: admitted, MatchedExact: true}, nil
		}
		return SearchOutcome{Results: []ScoredResult{}}, nil
	}
	admits := coldAdmission(hold, options.Filter)
	fromGraph, err := hold.field.Search(ctx, query, k, options, admits, view.removedNumbers)
	if err != nil {
		return SearchOutcome{}, err
	}
	results := mergeResults(fromGraph, scanWritten(view, query, k, options, admits), k)
	if math.IsInf(options.MinSimilarity, -1) {
		return SearchOutcome{Results: results, Matched: admitted, MatchedExact: true}, nil
	}
	return SearchOutcome{Results: results, Matched: len(results)}, nil
}
