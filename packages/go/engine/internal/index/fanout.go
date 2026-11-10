package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type fanOutResult struct {
	scored       []partition.ScoredDocument
	totalMatched int
	inexact      bool
	facets       map[string]model.FacetResult
	paginate     func(placed []results.Hit, pinnedIDs map[string]struct{}) pageOfHits
}

func scoredBefore(left, right partition.ScoredDocument) bool {
	return left.Score > right.Score || left.Score == right.Score && text.CompareCodePoints(left.ID, right.ID) <= 0
}

func mergeTwoSorted(left, right []partition.ScoredDocument) []partition.ScoredDocument {
	merged := make([]partition.ScoredDocument, 0, len(left)+len(right))
	at, other := 0, 0
	for at < len(left) && other < len(right) {
		if scoredBefore(left[at], right[other]) {
			merged = append(merged, left[at])
			at++
			continue
		}
		merged = append(merged, right[other])
		other++
	}
	merged = append(merged, left[at:]...)
	return append(merged, right[other:]...)
}

func mergeScored(lists [][]partition.ScoredDocument) []partition.ScoredDocument {
	var merged []partition.ScoredDocument
	held := false
	for _, list := range lists {
		if len(list) == 0 {
			continue
		}
		if !held {
			merged, held = list, true
			continue
		}
		merged = mergeTwoSorted(merged, list)
	}
	return merged
}

func (ix *Index) fanOut(views []partition.View, plan *searchPlan, filter *partitionFilter) (fanOutResult, error) {
	if len(views) == 0 {
		return fanOutResult{}, nil
	}
	mode := ix.scoringModeOf(plan.query)
	if (mode == model.ScoringDFS || mode == model.ScoringBroadcast) && !isBlank(plan.query.Term) {
		plan.stats = ix.collectQueryTermStats(views, plan)
	}
	facetConfig := plan.query.Facets
	if len(views) == 1 {
		outcome, err := ix.searchPartition(views[0], plan, filter)
		if err != nil {
			return fanOutResult{}, err
		}
		result := fanOutResult{scored: outcome.scored, totalMatched: outcome.totalMatched}
		if facetConfig != nil {
			if result.facets, err = ix.facetsOf(views[0], outcome, facetConfig); err != nil {
				return fanOutResult{}, err
			}
		}
		return result, nil
	}
	lists := make([][]partition.ScoredDocument, 0, len(views))
	var partitionFacets []map[string]model.FacetResult
	everyValue := results.EveryValueFacetConfig(facetConfig)
	result := fanOutResult{}
	for _, view := range views {
		outcome, err := ix.searchPartition(view, plan, filter)
		if err != nil {
			return fanOutResult{}, err
		}
		if facetConfig != nil {
			counted, err := ix.facetsOf(view, outcome, everyValue)
			if err != nil {
				return fanOutResult{}, err
			}
			partitionFacets = append(partitionFacets, counted)
		}
		lists = append(lists, outcome.scored)
		result.totalMatched += outcome.totalMatched
	}
	if facetConfig != nil {
		result.facets = results.MergeFacets(partitionFacets, facetConfig)
	}
	result.scored = mergeScored(lists)
	return result, nil
}
