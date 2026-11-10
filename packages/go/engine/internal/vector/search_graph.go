package vector

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type searchDepths struct {
	ef        int
	depth     int
	quantised bool
}

func (f *Field) depthsFor(current *layout, k int, options SearchOptions) searchDepths {
	window := k
	if options.RescoreWindow > 0 {
		window = options.RescoreWindow
	}
	depth := window
	quantised := current.searchesCodes()
	if quantised {
		depth = RescoreDepth(f.config.bits, f.config.dimension, window, options.Oversample)
	}
	ef := defaultEfSearchFor(f.config.dimension, window)
	if options.EfSearch > 0 {
		ef = options.EfSearch
	}
	return searchDepths{ef: max(ef, depth), depth: depth, quantised: quantised}
}

func graphIsEmpty(graph *graphMemory) bool {
	return graph.word(core.GraphWordEntryPoint).Load() == noEntryPoint ||
		graph.word(core.GraphWordNodeCount).Load()-graph.word(core.GraphWordTombstoneCount).Load() == 0
}

func (f *Field) traverse(current *layout, slot uint32, request scanRequest, depths searchDepths,
	accepted *ordinalFilter, scratch *searchScratch) (int, error) {
	admitted := request.liveAtPin
	if accepted != nil {
		admitted = accepted.count
	}
	candidateCount := min(depths.ef, max(1, admitted))
	ordinals, estimates := scratch.candidatesFor(candidateCount)
	search := core.SearchRequest{
		Query:          request.query,
		Metric:         request.nativeMetric,
		CandidateCount: uint32(candidateCount),
		ThreadSlot:     slot,
		Pin:            request.pin,
	}
	if accepted != nil {
		search.Accepted = accepted.bits
		search.HasAccepted = true
	}
	count, err := scratch.workspace.Search(current.graph.native, current.native, search, ordinals, estimates)
	if err != nil {
		return 0, coreFailure("search", err)
	}
	return min(count, candidateCount), nil
}

func estimatedHits(hits []ordinalHit, scratch *searchScratch, count, from int, request scanRequest,
	accepted *ordinalFilter) []ordinalHit {
	for index := from; index < count; index++ {
		ordinal := scratch.candidates[index]
		if accepted != nil && !accepted.has(ordinal) {
			continue
		}
		score := toScore(scratch.estimates[index], request.metric)
		if score < request.minSimilarity {
			continue
		}
		hits = append(hits, ordinalHit{ordinal: ordinal, score: score})
	}
	return hits
}

func endOfRescored(scratch *searchScratch, count, depth int, accepted *ordinalFilter) int {
	if accepted == nil {
		return min(depth, count)
	}
	taken := 0
	for index := range count {
		if !accepted.has(scratch.candidates[index]) {
			continue
		}
		taken++
		if taken == depth {
			return index + 1
		}
	}
	return count
}

func (f *Field) rescoredHits(current *layout, request scanRequest, count, depth int, accepted *ordinalFilter,
	scratch *searchScratch) ([]ordinalHit, error) {
	nearest := min(count, depth)
	picked := scratch.picked[:0]
	for index := 0; index < count && len(picked) < nearest; index++ {
		ordinal := scratch.candidates[index]
		if accepted != nil && !accepted.has(ordinal) {
			continue
		}
		picked = append(picked, ordinal)
	}
	scratch.picked = picked
	distances := scratch.distancesFor(len(picked))
	err := scratch.workspace.Score(current.native, request.query, request.nativeMetric, request.pin, picked, distances)
	if err != nil {
		return nil, coreFailure("score", err)
	}
	hits := scratch.hits[:0]
	for index, ordinal := range picked {
		if math.IsInf(distances[index], 1) {
			continue
		}
		score := toScore(distances[index], request.metric)
		if score < request.minSimilarity {
			continue
		}
		hits = append(hits, ordinalHit{ordinal: ordinal, score: score})
	}
	return hits, nil
}

func compareHitScores(left, right ordinalHit) int {
	switch {
	case right.score > left.score:
		return 1
	case right.score < left.score:
		return -1
	case scoresTie(left.score, right.score):
		return 0
	case math.IsNaN(left.score):
		return 1
	}
	return -1
}

func bestResolvedHits(store *storeMemory, hits []ordinalHit, k int) []ScoredResult {
	if !slices.IsSortedFunc(hits, compareHitScores) {
		slices.SortStableFunc(hits, compareHitScores)
	}
	taken := make([]ScoredResult, 0, min(k, len(hits)))
	for _, hit := range hits {
		if len(taken) >= k && !scoresTie(hit.score, taken[k-1].Score) {
			break
		}
		taken = append(taken, ScoredResult{DocID: store.table.storedDocID(hit.ordinal), Score: hit.score})
	}
	orderTiedScoresByDocumentID(taken)
	return taken[:min(k, len(taken))]
}
