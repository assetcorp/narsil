package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (q *preparedQuery) textLeg(limit, offset int, dropsPlacement bool) *preparedQuery {
	leg := *q
	leg.params.Vector, leg.params.Mode, leg.params.Hybrid = nil, "", nil
	if dropsPlacement {
		leg.params.SearchAfter, leg.params.Pinned = model.Optional[string]{}, nil
	}
	leg.limit, leg.offset = limit, offset
	leg.vectorOnly, leg.hybrid = false, false
	return &leg
}

func scoredForFusion(documents []partition.ScoredDocument) []results.Scored {
	scored := make([]results.Scored, len(documents))
	for at, document := range documents {
		scored[at] = results.Scored{ID: document.ID, Score: document.Score}
		if document.Components != nil {
			scored[at].Components = *document.Components
		}
	}
	return scored
}

func vectorHitsForFusion(hits []VectorHit) []results.Scored {
	scored := make([]results.Scored, len(hits))
	for at, hit := range hits {
		scored[at] = results.Scored{ID: hit.ID, Score: hit.Score}
	}
	return scored
}

func scoredFromFusion(fused []results.Scored) []partition.ScoredDocument {
	scored := make([]partition.ScoredDocument, len(fused))
	for at, document := range fused {
		scored[at] = partition.ScoredDocument{ID: document.ID, Score: document.Score}
		if components := document.Components; components.TermFrequencies != nil || components.FieldLengths != nil || components.IDF != nil {
			scored[at].Components = &components
		}
	}
	return scored
}

func fuseLegs(fusion results.ResolvedFusion, text, vector []results.Scored) []results.Scored {
	if fusion.Strategy == model.HybridRRF {
		return results.ReciprocalRankFusion([][]results.Scored{text, vector}, fusion.K)
	}
	return results.LinearCombination(text, vector, fusion.Alpha)
}

func keptAtOrAbove(fused []results.Scored, threshold float64) []results.Scored {
	kept := fused[:0:0]
	for _, document := range fused {
		if document.Score >= threshold {
			kept = append(kept, document)
		}
	}
	return kept
}

func (ix *Index) hybridRanked(prepared *preparedQuery, pass *analysis.Pass, cursorDepth int) (fanOutResult, error) {
	if hybrid := prepared.params.Hybrid; hybrid != nil && hybrid.Depth.IsSet() {
		return ix.fixedDepthHybrid(prepared, pass, cursorDepth)
	}
	params := &prepared.params
	fusion, err := results.ResolveHybridFusion(params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	accepted, err := ix.acceptedForVectors(prepared.filter)
	if err != nil || accepted.matchesNothing() {
		return fanOutResult{}, err
	}
	text := prepared.textLeg(cursor.ClampLimit(params.Limit), cursor.ClampOffset(params.Offset), false)
	if params.Vector == nil || params.Vector.Value == nil {
		found, err := ix.textRanked(text, pass)
		return fanOutResult{scored: found.scored, totalMatched: found.totalMatched, facets: found.facets}, err
	}
	k, err := vectorFetchDepth(prepared.limit, prepared.offset, cursorDepth)
	if err != nil {
		return fanOutResult{}, err
	}
	outcome, textFound, err := bothLegs(func() (VectorOutcome, error) {
		return ix.searchVectorLeg(prepared.context(), params.Vector, k, 0, accepted)
	}, func() (fanOutResult, error) {
		return ix.textRanked(text, pass)
	})
	if err != nil {
		return fanOutResult{}, err
	}
	fused := fuseLegs(fusion, scoredForFusion(textFound.scored), vectorHitsForFusion(outcome.Hits))
	if minimum, set := params.MinScore.Get(); set && minimum > 0 {
		fused = keptAtOrAbove(fused, minimum)
	}
	textHoldsEveryMatch := len(textFound.scored) == textFound.totalMatched
	return fanOutResult{
		scored:       scoredFromFusion(fused),
		totalMatched: len(fused),
		inexact:      !(outcome.holdsEveryMatch() && textHoldsEveryMatch),
		facets:       textFound.facets,
	}, nil
}

func countOfUnion(text fanOutResult, vectorHits []VectorHit) int {
	textIDs := make(map[string]struct{}, len(text.scored))
	for _, document := range text.scored {
		textIDs[document.ID] = struct{}{}
	}
	vectorOnly := 0
	for _, hit := range vectorHits {
		if _, held := textIDs[hit.ID]; !held {
			vectorOnly++
		}
	}
	if len(text.scored) == text.totalMatched {
		return text.totalMatched + vectorOnly
	}
	return max(text.totalMatched, len(text.scored)+vectorOnly)
}

func (ix *Index) fusedAtDepth(prepared *preparedQuery, pass *analysis.Pass, depth int) (fanOutResult, error) {
	params := &prepared.params
	fusion, err := results.ResolveHybridFusion(params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	accepted, err := ix.acceptedForVectors(prepared.filter)
	if err != nil || accepted.matchesNothing() {
		return fanOutResult{}, err
	}
	text := prepared.textLeg(depth, 0, true)
	if params.Vector == nil || params.Vector.Value == nil {
		found, err := ix.textRanked(text, pass)
		return fanOutResult{scored: found.scored, totalMatched: found.totalMatched, facets: found.facets}, err
	}
	outcome, textFound, err := bothLegs(func() (VectorOutcome, error) {
		return ix.searchVectorLeg(prepared.context(), params.Vector, depth, hybridRescoreWindow, accepted)
	}, func() (fanOutResult, error) {
		return ix.textRanked(text, pass)
	})
	if err != nil {
		return fanOutResult{}, err
	}
	textScored := textFound.scored[:min(depth, len(textFound.scored))]
	fused := fuseLegs(fusion, scoredForFusion(textScored), vectorHitsForFusion(outcome.Hits))
	textHoldsEveryMatch := len(textFound.scored) == textFound.totalMatched
	threshold := params.MinScore.Or(0)
	filtersByScore := threshold > 0
	if filtersByScore {
		fused = keptAtOrAbove(fused, threshold)
	}
	result := fanOutResult{
		scored:  scoredFromFusion(fused[:min(depth, len(fused))]),
		facets:  textFound.facets,
		inexact: !(outcome.holdsEveryMatch() && textHoldsEveryMatch && (!filtersByScore || len(textScored) == textFound.totalMatched)),
	}
	if filtersByScore {
		result.totalMatched = len(fused)
	} else {
		result.totalMatched = countOfUnion(textFound, outcome.Hits)
	}
	return result, nil
}

func (ix *Index) fixedDepthHybrid(prepared *preparedQuery, pass *analysis.Pass, cursorDepth int) (fanOutResult, error) {
	depth, _, err := results.FixedHybridDepth(prepared.params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	if err := results.RequireWithinHybridDepth(cursorDepth, prepared.offset, depth); err != nil {
		return fanOutResult{}, err
	}
	found, err := ix.fusedAtDepth(prepared, pass, depth)
	if err != nil {
		return fanOutResult{}, err
	}
	organic := make([]string, len(found.scored))
	for at, document := range found.scored {
		organic[at] = document.ID
	}
	start := cursorDepth + prepared.offset
	found.paginate = func(placed []results.Hit, pinnedIDs map[string]struct{}) pageOfHits {
		window := results.PositionPage{Start: start, Limit: prepared.limit}
		order := organic
		if pinnedIDs == nil {
			order = make([]string, len(placed))
			for at, hit := range placed {
				order[at] = hit.ID
			}
		} else {
			window.PinnedIDs = model.Some(pinnedIDs)
		}
		page, next := results.PageByPosition(placed, order, window)
		if next == nil {
			return pageOfHits{hits: page}
		}
		encoded := cursor.EncodePageCursor(cursor.PageCursor{Anchor: next.Anchor, Score: next.Score, Depth: next.Depth, Binding: prepared.binding()})
		return pageOfHits{hits: page, cursor: encoded}
	}
	return found, nil
}
