package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type fanOutResult struct {
	scored       []scoredHit
	totalMatched int
	inexact      bool
	facets       map[string]model.FacetResult
	paginate     func(placed []resultHit, pinnedIDs map[string]struct{}) pageOfHits
}

func (ix *Index) fanOut(prepared *preparedQuery, plan *searchPlan) (fanOutResult, error) {
	views, err := prepared.reads.views.all()
	if err != nil || len(views) == 0 {
		return fanOutResult{}, err
	}
	snapshots := prepared.reads.reading.Snapshots
	mode := ix.scoringModeOf(plan.query)
	if (mode == model.ScoringDFS || mode == model.ScoringBroadcast) && !isBlank(plan.query.Term) {
		if plan.stats, err = ix.collectQueryTermStats(views, plan); err != nil {
			return fanOutResult{}, err
		}
	}
	facetConfig := plan.query.Facets
	if len(views) == 1 {
		outcome, err := ix.searchPartition(snapshots[0], views[0], plan)
		if err != nil {
			return fanOutResult{}, err
		}
		result := fanOutResult{scored: outcome.scored, totalMatched: outcome.totalMatched}
		if facetConfig != nil {
			if result.facets, err = facetsOf(views[0], outcome.matched, facetConfig); err != nil {
				return fanOutResult{}, err
			}
		}
		return result, nil
	}
	lists := make([][]scoredHit, 0, len(views))
	var partitionFacets []map[string]model.FacetResult
	everyValue := everyValueFacetConfig(facetConfig)
	result := fanOutResult{}
	for at, view := range views {
		outcome, err := ix.searchPartition(snapshots[at], view, plan)
		if err != nil {
			return fanOutResult{}, err
		}
		if facetConfig != nil {
			counted, err := facetsOf(view, outcome.matched, everyValue)
			if err != nil {
				return fanOutResult{}, err
			}
			partitionFacets = append(partitionFacets, counted)
		}
		lists = append(lists, outcome.scored)
		result.totalMatched += outcome.totalMatched
	}
	if facetConfig != nil {
		if result.facets, err = query.MergeFacets(partitionFacets, facetConfig); err != nil {
			return fanOutResult{}, err
		}
	}
	if result.scored, err = mergeScored(lists); err != nil {
		return fanOutResult{}, err
	}
	return result, nil
}
