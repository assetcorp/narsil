package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
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

func resolveHybridFusion(hybrid *model.HybridConfig) (query.FusionSettings, error) {
	if hybrid == nil {
		return query.ResolveFusion("", nil, nil)
	}
	var k, alpha *float64
	if value, set := hybrid.K.Get(); set {
		widened := float64(value)
		k = &widened
	}
	if value, set := hybrid.Alpha.Get(); set {
		alpha = &value
	}
	return query.ResolveFusion(string(hybrid.Strategy), k, alpha)
}

func fuseLegs(fusion query.FusionSettings, text []scoredHit, vector []VectorHit) ([]scoredHit, error) {
	textLeg := make([]query.RankedEntry, len(text))
	components := make(map[string]*model.ScoreComponents, len(text))
	for at, hit := range text {
		textLeg[at] = query.RankedEntry{ID: hit.ID, Score: hit.Score}
		if hit.Components != nil {
			components[hit.ID] = hit.Components
		}
	}
	vectorLeg := make([]query.RankedEntry, len(vector))
	for at, hit := range vector {
		vectorLeg[at] = query.RankedEntry{ID: hit.ID, Score: hit.Score}
	}
	fused, err := query.Fuse(textLeg, vectorLeg, fusion)
	if err != nil {
		return nil, err
	}
	scored := make([]scoredHit, len(fused))
	for at, entry := range fused {
		scored[at] = scoredHit{ID: entry.ID, Score: entry.Score, Components: components[entry.ID]}
	}
	return scored, nil
}

func keptAtOrAbove(fused []scoredHit, threshold float64) []scoredHit {
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
	fusion, err := resolveHybridFusion(params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	accepted, err := ix.acceptedForVectors(prepared)
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
	fused, err := fuseLegs(fusion, textFound.scored, outcome.Hits)
	if err != nil {
		return fanOutResult{}, err
	}
	if minimum, set := params.MinScore.Get(); set && minimum > 0 {
		fused = keptAtOrAbove(fused, minimum)
	}
	textHoldsEveryMatch := len(textFound.scored) == textFound.totalMatched
	return fanOutResult{
		scored:       fused,
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
	fusion, err := resolveHybridFusion(params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	accepted, err := ix.acceptedForVectors(prepared)
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
	fused, err := fuseLegs(fusion, textScored, outcome.Hits)
	if err != nil {
		return fanOutResult{}, err
	}
	textHoldsEveryMatch := len(textFound.scored) == textFound.totalMatched
	threshold := params.MinScore.Or(0)
	filtersByScore := threshold > 0
	if filtersByScore {
		fused = keptAtOrAbove(fused, threshold)
	}
	result := fanOutResult{
		scored:  fused[:min(depth, len(fused))],
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
	depth, _, err := fixedHybridDepth(prepared.params.Hybrid)
	if err != nil {
		return fanOutResult{}, err
	}
	if err := requireWithinHybridDepth(cursorDepth, prepared.offset, depth); err != nil {
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
	found.paginate = func(placed []resultHit, pinnedIDs map[string]struct{}) pageOfHits {
		window := positionPage{start: start, limit: prepared.limit}
		order := organic
		if pinnedIDs == nil {
			order = make([]string, len(placed))
			for at, hit := range placed {
				order[at] = hit.ID
			}
		} else {
			window.pinnedIDs = model.Some(pinnedIDs)
		}
		page, next := pageByPosition(placed, order, window)
		if next == nil {
			return pageOfHits{hits: page}
		}
		encoded := cursor.EncodePageCursor(cursor.PageCursor{Anchor: next.anchor, Score: next.score, Depth: next.depth, Binding: prepared.binding.Text()})
		return pageOfHits{hits: page, cursor: encoded}
	}
	return found, nil
}
