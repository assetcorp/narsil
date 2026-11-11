package vector

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func (h *coldHold) writtenVector(ordinal int32, dimension int) ([]float32, bool) {
	stored := h.stored.Load()
	if stored == nil {
		return nil, false
	}
	current := stored.acquire()
	if current == nil {
		return nil, false
	}
	defer current.done()
	values := make([]float32, dimension)
	if !current.store.readStoredVector(current.tables, ordinal, values) {
		return nil, false
	}
	return values, true
}

func (h *coldHold) scoreWritten(view *coldView, query []float32, metric core.Metric, ordinals []int32,
	distances []float64) error {
	for at := range distances {
		distances[at] = math.Inf(1)
	}
	if len(ordinals) == 0 {
		return nil
	}
	stored := h.stored.Load()
	if stored == nil {
		return nil
	}
	current := stored.acquire()
	if current == nil {
		return nil
	}
	defer current.done()
	return withWorkspace(func(workspace *core.Workspace) error {
		if err := workspace.Score(current.native, query, metric, view.sequence, ordinals, distances); err != nil {
			return coreFailure("score", err)
		}
		return nil
	})
}

type coldScanCandidates struct {
	docIDs   []string
	ordinals []int32
	numbers  []int
}

func admitScored(tally *scanTally, docIDs []string, distances []float64, options SearchOptions) {
	for at, docID := range docIDs {
		if math.IsInf(distances[at], 1) {
			continue
		}
		if score := toScore(distances[at], options.Metric); score >= options.MinSimilarity {
			tally.admit(docID, score)
		}
	}
}

func scanWritten(hold *coldHold, view *coldView, query []float32, k int, options SearchOptions,
	admits func(docID string) (bool, error)) ([]ScoredResult, error) {
	if len(view.written) == 0 {
		return []ScoredResult{}, nil
	}
	var candidates coldScanCandidates
	for docID, ordinal := range view.written {
		if admits != nil {
			admitted, err := admits(docID)
			if err != nil {
				return nil, err
			}
			if !admitted {
				continue
			}
		}
		candidates.docIDs = append(candidates.docIDs, docID)
		candidates.ordinals = append(candidates.ordinals, ordinal)
	}
	metric, _ := nativeMetricOf(options.Metric)
	distances := make([]float64, len(candidates.ordinals))
	if err := hold.scoreWritten(view, query, metric, candidates.ordinals, distances); err != nil {
		return nil, err
	}
	tally := newScanTally(max(k, 1))
	admitScored(tally, candidates.docIDs, distances, options)
	return tally.results(), nil
}

func scanAcceptedDocIDs(hold *coldHold, view *coldView, query []float32, k int,
	options SearchOptions) (SearchOutcome, error) {
	var written, cold coldScanCandidates
	for _, docID := range uniqueDocIDs(options.Filter.docIDs) {
		if ordinal, held := view.written[docID]; held {
			written.docIDs = append(written.docIDs, docID)
			written.ordinals = append(written.ordinals, ordinal)
			continue
		}
		if _, removed := view.removedIDs[docID]; removed {
			continue
		}
		number, held, err := hold.field.NumberOf(docID)
		if err != nil {
			return SearchOutcome{}, err
		}
		if held {
			cold.docIDs = append(cold.docIDs, docID)
			cold.numbers = append(cold.numbers, number)
		}
	}
	metric, _ := nativeMetricOf(options.Metric)
	writtenDistances := make([]float64, len(written.ordinals))
	if err := hold.scoreWritten(view, query, metric, written.ordinals, writtenDistances); err != nil {
		return SearchOutcome{}, err
	}
	coldDistances := make([]float64, len(cold.numbers))
	if err := hold.field.ScoreNumbers(query, metric, cold.numbers, coldDistances); err != nil {
		return SearchOutcome{}, err
	}
	tally := newScanTally(max(k, 1))
	admitScored(tally, written.docIDs, writtenDistances, options)
	admitScored(tally, cold.docIDs, coldDistances, options)
	results := tally.results()
	return SearchOutcome{Results: results[:min(len(results), max(k, 0))], Matched: tally.matched,
		MatchedExact: true}, nil
}
