package vector

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type SearchOptions struct {
	Metric        model.VectorMetric
	MinSimilarity float64
	Filter        *Filter
	EfSearch      int
	Oversample    float64
	RescoreWindow int
}

func validateSearch(k int, options SearchOptions) error {
	invalid := func(message string, details map[string]any) error {
		return narsilerr.New(narsilerr.CodeConfigInvalid, message, details)
	}
	if _, known := nativeMetricOf(options.Metric); !known {
		return invalid("vector metric must be 'cosine', 'dotProduct', or 'euclidean'",
			map[string]any{"metric": string(options.Metric)})
	}
	if math.IsNaN(options.MinSimilarity) {
		return invalid("vector.similarity must be a number", map[string]any{})
	}
	if k < 0 || k > MaxSearchCandidates {
		return invalid("a vector search asks for a negative or oversized number of results",
			map[string]any{"k": float64(k), "maximum": float64(MaxSearchCandidates)})
	}
	if options.EfSearch < 0 || options.EfSearch > MaxSearchCandidates {
		return invalid("vector.efSearch must be a positive integer within the search limit",
			map[string]any{"efSearch": float64(options.EfSearch), "maximum": float64(MaxSearchCandidates)})
	}
	if options.Oversample != 0 && (math.IsNaN(options.Oversample) || math.IsInf(options.Oversample, 0) ||
		options.Oversample < minOversample) {
		return invalid("vector.oversample must be a finite number of at least 1",
			map[string]any{"oversample": options.Oversample})
	}
	if options.RescoreWindow < 0 || options.RescoreWindow > MaxSearchCandidates {
		return invalid("the rescore window of a vector search is out of range",
			map[string]any{"rescoreWindow": float64(options.RescoreWindow)})
	}
	return nil
}

func emptyOutcome() SearchOutcome {
	return SearchOutcome{Results: []ScoredResult{}, Matched: 0, MatchedExact: true}
}

func fetchedOutcome(live int, results []ScoredResult, minSimilarity float64, accepted *ordinalFilter) SearchOutcome {
	if !math.IsInf(minSimilarity, -1) {
		return SearchOutcome{Results: results, Matched: len(results)}
	}
	admitted := live
	if accepted != nil {
		admitted = accepted.count
	}
	return SearchOutcome{Results: results, Matched: admitted, MatchedExact: true}
}

func (f *Field) Search(ctx context.Context, query []float32, k int, options SearchOptions) (SearchOutcome, error) {
	if len(query) != f.config.dimension {
		return SearchOutcome{}, dimensionMismatch(f.config.dimension, len(query))
	}
	if options.Metric == "" {
		options.Metric = model.MetricCosine
	}
	if err := validateSearch(k, options); err != nil {
		return SearchOutcome{}, err
	}
	if err := ctx.Err(); err != nil {
		return SearchOutcome{}, err
	}
	for hold := f.coldHoldNow(); hold != nil; hold = f.coldHoldNow() {
		if failure := hold.replayFailure(); failure != nil {
			return SearchOutcome{}, failure
		}
		outcome, err := f.coldSearch(ctx, hold, query, k, options)
		if failure := hold.replayFailure(); failure != nil {
			return SearchOutcome{}, failure
		}
		if f.coldHoldNow() == hold || ctx.Err() != nil {
			return outcome, err
		}
	}
	if err := f.ensureFilesOpen(); err != nil {
		return SearchOutcome{}, err
	}
	current := f.acquireLayout()
	if current == nil {
		return emptyOutcome(), nil
	}
	lease, release, err := f.slots.searchLease(ctx)
	if err != nil {
		current.done()
		return SearchOutcome{}, err
	}
	defer release()
	if current = f.layoutPublishedBy(current); current == nil {
		return emptyOutcome(), nil
	}
	defer current.done()
	f.nudgeBuild()
	return f.searchLayout(ctx, current, lease, query, k, options)
}

func (f *Field) searchLayout(ctx context.Context, current *layout, lease *Lease, query []float32, k int,
	options SearchOptions) (SearchOutcome, error) {
	accepted := filterOf(current, options.Filter, lease.pin)
	live := liveAtPin(current, lease.pin)
	if live <= 0 || (accepted != nil && accepted.count == 0) {
		return emptyOutcome(), nil
	}
	if k <= 0 {
		return fetchedOutcome(live, []ScoredResult{}, options.MinSimilarity, accepted), nil
	}
	metric, _ := nativeMetricOf(options.Metric)
	request := scanRequest{query: query, metric: options.Metric, nativeMetric: metric,
		minSimilarity: options.MinSimilarity, pin: lease.pin, liveAtPin: live}
	scratch, err := acquireSearchScratch()
	if err != nil {
		return SearchOutcome{}, err
	}
	defer scratch.release()
	graph := current.graph
	if graph == nil || f.filterIsNarrow(graph, accepted) {
		walk := everyLiveOrdinal(current)
		if accepted != nil {
			walk = accepted.each
		}
		tally, err := f.scanOrdinals(ctx, current, request, k, scratch, walk)
		if err != nil {
			return SearchOutcome{}, err
		}
		return SearchOutcome{Results: tally.results(), Matched: tally.matched, MatchedExact: true}, nil
	}
	var outside *scanTally
	if current.store.unplacedCount.Load()+current.store.retiredScans.Load() > 0 || graph.alsoScan.Load() != nil {
		outside, err = f.scanOrdinals(ctx, current, request, k, scratch, outsideTheGraph(current, accepted))
		if err != nil {
			return SearchOutcome{}, err
		}
	}
	lease.enter(graph)
	graphResults, err := f.graphResults(current, lease.slot, request, k, options, accepted, scratch)
	lease.leave()
	if err != nil {
		return SearchOutcome{}, err
	}
	if outside == nil {
		return fetchedOutcome(live, graphResults, options.MinSimilarity, accepted), nil
	}
	return fetchedOutcome(live, mergeResults(graphResults, outside.results(), k), options.MinSimilarity, accepted), nil
}

func (f *Field) filterIsNarrow(graph *graphMemory, accepted *ordinalFilter) bool {
	if accepted == nil {
		return false
	}
	held := graph.size()
	selectivity := 1.0
	if held > 0 {
		selectivity = float64(accepted.count) / float64(held)
	}
	return selectivity < f.config.filterThreshold
}

func (f *Field) graphResults(current *layout, slot uint32, request scanRequest, k int, options SearchOptions,
	accepted *ordinalFilter, scratch *searchScratch) ([]ScoredResult, error) {
	if graphIsEmpty(current.graph) {
		return []ScoredResult{}, nil
	}
	depths := f.depthsFor(current, k, options)
	count, err := f.traverse(current, slot, request, depths, accepted, scratch)
	if err != nil {
		return nil, err
	}
	var hits []ordinalHit
	if !depths.quantised {
		hits = estimatedHits(scratch.hits[:0], scratch, count, 0, request, accepted)
	} else {
		hits, err = f.rescoredHits(current, request, count, depths.depth, accepted, scratch)
		if err != nil {
			return nil, err
		}
		if options.RescoreWindow > 0 && math.IsInf(request.minSimilarity, -1) {
			rest := endOfRescored(scratch, count, depths.depth, accepted)
			hits = estimatedHits(hits, scratch, count, rest, request, accepted)
		}
	}
	scratch.hits = hits
	return bestResolvedHits(current.store, hits, k), nil
}
