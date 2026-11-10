package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type shapedResult struct {
	result    model.QueryResult
	documents *documentLookup
}

func pinnedParamIDs(pinned []model.PinnedDocument) map[string]struct{} {
	ids := make(map[string]struct{}, len(pinned))
	for _, entry := range pinned {
		ids[entry.DocID] = struct{}{}
	}
	return ids
}

func (ix *Index) shapeResults(prepared *preparedQuery, found fanOutResult) (shapedResult, error) {
	params := &prepared.params
	documents := newDocumentLookup(ix, prepared.reads.reading)
	needsFullHits := params.Sort != nil || params.Group != nil || params.Pinned != nil || params.SearchAfter.IsSet()
	count := len(found.scored)
	if !needsFullHits {
		count = min(prepared.offset+prepared.limit+1, count)
	}
	hits := hitsOf(found.scored, count, params.IncludeScoreComponents)
	sortKeys := found.sortKeys
	if len(params.Sort) > 0 && sortKeys == nil {
		sorted, keys, err := ix.hitsInSortOrder(prepared, hits)
		if err != nil {
			return shapedResult{}, err
		}
		hits, sortKeys = sorted, keys
	}
	var groups []hitGroup
	if params.Group != nil {
		grouped, err := ix.applyGrouping(prepared, hits, *params.Group, documents)
		if err != nil {
			return shapedResult{}, err
		}
		groups = grouped
	}
	placesPins := params.Pinned != nil && !params.SearchAfter.IsSet()
	pinsFromOutside := 0
	var pinnedIDs map[string]struct{}
	if placesPins {
		placed, fromOutside, err := placePinned(hits, storedPinsOf(params.Pinned, documents.has))
		if err != nil {
			return shapedResult{}, err
		}
		hits, pinsFromOutside = placed, fromOutside
		pinnedIDs = pinnedParamIDs(params.Pinned)
	}
	var sorting *paginationSort
	if signature, sorted := prepared.sortSignature.Get(); sorted {
		sorting = &paginationSort{signature: signature, directions: sortDirectionsOf(params.Sort), sortKeyOf: func(id string) []text.SortValue { return sortKeys[id] }}
	}
	var page pageOfHits
	if found.paginate != nil {
		page = found.paginate(hits, pinnedIDs)
	} else {
		searchAfter, _ := params.SearchAfter.Get()
		paged, err := applyPagination(hits, prepared.limit, prepared.offset, prepared.binding, searchAfter, sorting, pinnedIDs, sortsWithoutScores(prepared))
		if err != nil {
			return shapedResult{}, err
		}
		page = paged
	}
	holdsEveryMatch := !found.inexact && len(found.scored) == found.totalMatched
	result := model.QueryResult{Count: found.totalMatched, CountExact: !found.inexact && (holdsEveryMatch || pinsFromOutside == 0), Cursor: page.cursor, Facets: found.facets}
	if holdsEveryMatch {
		result.Count += pinsFromOutside
	}
	dropsScores := sorting != nil && !params.IncludeScores
	result.Hits = ix.projectedHits(page.hits, prepared, documents, dropsScores)
	if groups != nil {
		result.Groups = make([]model.GroupResult, len(groups))
		for at, group := range groups {
			result.Groups[at] = model.GroupResult{
				Values:       group.values,
				Hits:         ix.projectedHits(group.hits, prepared, documents, dropsScores),
				Reduced:      group.reduced,
				ReducerError: group.reducerError.Or(""),
			}
		}
	}
	return shapedResult{result: result, documents: documents}, documents.failure()
}

func sortsWithoutScores(prepared *preparedQuery) bool {
	params := &prepared.params
	return prepared.sortSignature.IsSet() && !isBlank(params.Term) && !prepared.vectorOnly && !prepared.hybrid && !params.IncludeScores && !params.IncludeScoreComponents &&
		!params.MinScore.IsSet() && params.Group == nil && params.Pinned == nil && !termMatchFilters(params.TermMatch)
}

func (ix *Index) projectedHits(hits []resultHit, prepared *preparedQuery, documents *documentLookup, dropsScores bool) []model.Hit {
	projected := make([]model.Hit, len(hits))
	whole := prepared.projection.Kind() == model.ProjectWholeDocument
	for at, hit := range hits {
		shown := model.Hit{ID: hit.ID, Score: hit.Score, ScoreComponents: hit.Components}
		if dropsScores {
			shown.Score = model.Optional[float64]{}
		}
		shown.Document = documents.shown(hit.ID, prepared.projection, whole && prepared.params.Group == nil)
		projected[at] = shown
	}
	return projected
}

func (l *documentLookup) shown(id string, shown projection.Projection, handsOver bool) *model.Document {
	switch shown.Kind() {
	case model.ProjectNoFields:
		return model.NewDocument()
	case model.ProjectSelectedFields:
		if stored := l.decoded(id); stored != nil {
			return shown.Clone(stored)
		}
		return model.NewDocument()
	}
	stored := l.stored(id)
	if stored == nil {
		return model.NewDocument()
	}
	if handsOver && l.handOver(id) {
		return stored
	}
	return shown.Clone(stored)
}
