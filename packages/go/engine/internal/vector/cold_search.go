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

func (h *coldHold) vectorOfIn(view *coldView, docID string, dimension int) ([]float32, bool, error) {
	if ordinal, held := view.written[docID]; held {
		values, read := h.writtenVector(ordinal, dimension)
		return values, read, nil
	}
	if _, removed := view.removedIDs[docID]; removed {
		return nil, false, nil
	}
	number, held, err := h.field.NumberOf(docID)
	if err != nil || !held {
		return nil, false, err
	}
	values, err := h.field.VectorOfNumber(number)
	if err != nil {
		return nil, false, err
	}
	return values, true, nil
}

func (f *Field) coldVectorOf(hold *coldHold, docID string) ([]float32, bool, error) {
	defer hold.wantLoad()
	return hold.vectorOfIn(f.coldView(hold), docID, f.config.dimension)
}

func (f *Field) coldHas(hold *coldHold, docID string) (bool, error) {
	view := f.coldView(hold)
	if _, held := view.written[docID]; held {
		return true, nil
	}
	if _, removed := view.removedIDs[docID]; removed {
		return false, nil
	}
	_, held, err := hold.field.NumberOf(docID)
	return held && err == nil, err
}

func coldAdmission(ctx context.Context, hold *coldHold, filter *Filter) func(docID string) (bool, error) {
	if filter == nil {
		return nil
	}
	if filter.byPartitions {
		return func(docID string) (bool, error) {
			partition, known, err := hold.field.PartitionOf(ctx, docID)
			if err != nil || !known {
				return false, err
			}
			_, wanted := filter.partitions[partition]
			return wanted, nil
		}
	}
	accepted := make(map[string]struct{}, len(filter.docIDs))
	for _, docID := range filter.docIDs {
		accepted[docID] = struct{}{}
	}
	return func(docID string) (bool, error) {
		_, held := accepted[docID]
		return held, nil
	}
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
			return scanAcceptedDocIDs(hold, view, query, k, options)
		}
	}
	if k <= 0 {
		if math.IsInf(options.MinSimilarity, -1) {
			return SearchOutcome{Results: []ScoredResult{}, Matched: admitted, MatchedExact: true}, nil
		}
		return SearchOutcome{Results: []ScoredResult{}}, nil
	}
	admits := coldAdmission(ctx, hold, options.Filter)
	fromGraph, err := hold.field.Search(ctx, query, k, options, view.removedNumbers)
	if err != nil {
		return SearchOutcome{}, err
	}
	fromWritten, err := scanWritten(hold, view, query, k, options, admits)
	if err != nil {
		return SearchOutcome{}, err
	}
	results := mergeResults(fromGraph, fromWritten, k)
	if math.IsInf(options.MinSimilarity, -1) {
		return SearchOutcome{Results: results, Matched: admitted, MatchedExact: true}, nil
	}
	return SearchOutcome{Results: results, Matched: len(results)}, nil
}
