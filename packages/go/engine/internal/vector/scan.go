package vector

import (
	"context"
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ScoredResult struct {
	DocID string
	Score float64
}

type SearchOutcome struct {
	Results      []ScoredResult
	Matched      int
	MatchedExact bool
}

func highScoreFirst(left, right ScoredResult) int {
	if left.Score > right.Score {
		return -1
	}
	if left.Score < right.Score {
		return 1
	}
	return text.CompareCodePoints(left.DocID, right.DocID)
}

func toScore(distance float64, metric model.VectorMetric) float64 {
	switch metric {
	case model.MetricDotProduct:
		return -distance
	case model.MetricEuclidean:
		return 1 / (1 + distance)
	}
	return 1 - distance
}

type scanTally struct {
	best     []ScoredResult
	capacity int
	matched  int
}

func newScanTally(capacity int) *scanTally {
	return &scanTally{capacity: capacity}
}

func (t *scanTally) worse(left, right int) bool {
	return highScoreFirst(t.best[left], t.best[right]) > 0
}

func (t *scanTally) siftUp(at int) {
	for at > 0 {
		parent := (at - 1) / 2
		if !t.worse(at, parent) {
			return
		}
		t.best[at], t.best[parent] = t.best[parent], t.best[at]
		at = parent
	}
}

func (t *scanTally) siftDown(at int) {
	for {
		worst := at
		for _, child := range [2]int{2*at + 1, 2*at + 2} {
			if child < len(t.best) && t.worse(child, worst) {
				worst = child
			}
		}
		if worst == at {
			return
		}
		t.best[at], t.best[worst] = t.best[worst], t.best[at]
		at = worst
	}
}

func (t *scanTally) admit(docID string, score float64) {
	t.matched++
	result := ScoredResult{DocID: docID, Score: score}
	if len(t.best) < t.capacity {
		t.best = append(t.best, result)
		t.siftUp(len(t.best) - 1)
		return
	}
	if len(t.best) > 0 && highScoreFirst(result, t.best[0]) < 0 {
		t.best[0] = result
		t.siftDown(0)
	}
}

func (t *scanTally) results() []ScoredResult {
	ordered := append([]ScoredResult(nil), t.best...)
	slices.SortFunc(ordered, highScoreFirst)
	return ordered
}

type scanRequest struct {
	query         []float32
	metric        model.VectorMetric
	nativeMetric  core.Metric
	minSimilarity float64
}

func (f *Field) scoreOrdinals(current *layout, request scanRequest, ordinals []int32, tally *scanTally,
	scratch *searchScratch) error {
	for start := 0; start < len(ordinals); start += scanChunkOrdinals {
		chunk := ordinals[start:min(len(ordinals), start+scanChunkOrdinals)]
		distances := scratch.distancesFor(len(chunk))
		if err := scratch.workspace.Score(current.native, request.query, request.nativeMetric, chunk, distances); err != nil {
			return coreFailure("score", err)
		}
		for index, ordinal := range chunk {
			if math.IsInf(distances[index], 1) {
				continue
			}
			score := toScore(distances[index], request.metric)
			if score < request.minSimilarity {
				continue
			}
			docID, held := current.store.docIDOf(ordinal)
			if !held {
				continue
			}
			tally.admit(docID, score)
		}
	}
	return nil
}

func (f *Field) scanOrdinals(ctx context.Context, current *layout, request scanRequest, k int, scratch *searchScratch,
	each func(visit func(ordinal int32) bool)) (*scanTally, error) {
	tally := newScanTally(k)
	batch := scratch.batch[:0]
	var failure error
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		if failure = ctx.Err(); failure != nil {
			return false
		}
		failure = f.scoreOrdinals(current, request, batch, tally, scratch)
		batch = batch[:0]
		return failure == nil
	}
	each(func(ordinal int32) bool {
		if !liveOrdinal(current.store, ordinal) {
			return true
		}
		batch = append(batch, ordinal)
		if len(batch) < scanChunkOrdinals {
			return true
		}
		return flush()
	})
	if failure == nil {
		flush()
	}
	scratch.batch = batch[:0]
	return tally, failure
}

func everyLiveOrdinal(current *layout) func(visit func(ordinal int32) bool) {
	return func(visit func(ordinal int32) bool) {
		for ordinal := range current.store.slots() {
			if !visit(ordinal) {
				return
			}
		}
	}
}

func unplacedOrdinals(current *layout, accepted *ordinalFilter) func(visit func(ordinal int32) bool) {
	return func(visit func(ordinal int32) bool) {
		current.store.table.eachUnplaced(func(ordinal int32) bool {
			if accepted != nil && !accepted.has(ordinal) {
				return true
			}
			return visit(ordinal)
		})
	}
}

func mergeResults(graphResults, bufferResults []ScoredResult, k int) []ScoredResult {
	seen := make(map[string]struct{}, min(k, len(graphResults)+len(bufferResults)))
	merged := make([]ScoredResult, 0, min(k, len(graphResults)+len(bufferResults)))
	graphAt, bufferAt := 0, 0
	for len(merged) < k && (graphAt < len(graphResults) || bufferAt < len(bufferResults)) {
		var pick ScoredResult
		switch {
		case graphAt < len(graphResults) && bufferAt < len(bufferResults):
			fromGraph, fromBuffer := graphResults[graphAt], bufferResults[bufferAt]
			if fromGraph.Score > fromBuffer.Score ||
				(fromGraph.Score == fromBuffer.Score && text.CompareCodePoints(fromGraph.DocID, fromBuffer.DocID) < 0) {
				pick = fromGraph
				graphAt++
			} else {
				pick = fromBuffer
				bufferAt++
			}
		case graphAt < len(graphResults):
			pick = graphResults[graphAt]
			graphAt++
		default:
			pick = bufferResults[bufferAt]
			bufferAt++
		}
		if _, held := seen[pick.DocID]; held {
			continue
		}
		seen[pick.DocID] = struct{}{}
		merged = append(merged, pick)
	}
	return merged
}
