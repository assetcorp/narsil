package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type shapedResult struct {
	result    model.QueryResult
	documents *documentLookup
}

type documentLookup struct {
	index   *Index
	held    map[string]*partition.StoredDocument
	missing map[string]struct{}
}

func newDocumentLookup(index *Index, scored []partition.ScoredDocument) *documentLookup {
	lookup := &documentLookup{index: index, held: make(map[string]*partition.StoredDocument, len(scored)), missing: map[string]struct{}{}}
	for _, document := range scored {
		if document.Document != nil {
			lookup.held[document.ID] = document.Document
		}
	}
	return lookup
}

func (l *documentLookup) stored(id string) *partition.StoredDocument {
	if held, found := l.held[id]; found {
		return held
	}
	if _, absent := l.missing[id]; absent {
		return nil
	}
	found, present := l.index.Get(id)
	if !present {
		l.missing[id] = struct{}{}
		return nil
	}
	l.held[id] = found
	return found
}

func (l *documentLookup) FieldValues(id string, paths []string) []results.StoredValue {
	document := l.stored(id)
	if document == nil {
		return nil
	}
	values := make([]results.StoredValue, len(paths))
	for at, path := range paths {
		value, present := partition.NestedValue(document.Fields, path)
		values[at] = results.StoredValue{Value: value, Present: present}
	}
	return values
}

func (l *documentLookup) Document(id string) (model.Document, bool) {
	document := l.stored(id)
	if document == nil {
		return nil, false
	}
	return document.Fields, true
}

func hitsOf(scored []partition.ScoredDocument, count int, withComponents bool) []results.Hit {
	hits := make([]results.Hit, count)
	for at := range hits {
		hits[at] = results.Hit{ID: scored[at].ID, Score: model.Some(scored[at].Score)}
		if withComponents {
			hits[at].Components = scored[at].Components
			if hits[at].Components == nil {
				hits[at].Components = &model.ScoreComponents{TermFrequencies: map[string]float64{}, FieldLengths: map[string]float64{}, IDF: map[string]float64{}}
			}
		}
	}
	return hits
}

func (ix *Index) sortKeyReader(prepared *preparedQuery, documents *documentLookup) func(id string) []text.SortValue {
	fields := sortFieldNames(prepared.params.Sort)
	modes := results.SortModesOf(prepared.params.Sort)
	cache := map[string][]text.SortValue{}
	return func(id string) []text.SortValue {
		if key, cached := cache[id]; cached {
			return key
		}
		key := ix.sortValuesOf(documents.stored(id), fields, modes)
		cache[id] = key
		return key
	}
}

func (ix *Index) shapeResults(prepared *preparedQuery, found fanOutResult) (shapedResult, error) {
	params := &prepared.params
	documents := newDocumentLookup(ix, found.scored)
	needsFullHits := params.Sort != nil || params.Group != nil || params.Pinned != nil || params.SearchAfter.IsSet()
	count := len(found.scored)
	if !needsFullHits {
		count = min(prepared.offset+prepared.limit+1, count)
	}
	hits := hitsOf(found.scored, count, params.IncludeScoreComponents)
	sortKeyOf := ix.sortKeyReader(prepared, documents)
	if params.Sort != nil {
		hits = results.ApplySorting(hits, params.Sort, sortKeyOf)
	}
	var groups []results.Group
	if params.Group != nil {
		groups = results.ApplyGrouping(hits, *params.Group, documents)
	}
	pinsFromOutside := 0
	if params.Pinned != nil && !params.SearchAfter.IsSet() {
		hits, pinsFromOutside = results.PlacePinned(hits, params.Pinned, func(id string) (results.Hit, bool) {
			document := documents.stored(id)
			if document == nil {
				return results.Hit{}, false
			}
			return results.Hit{ID: id, Score: model.Some(0.0)}, true
		})
	}
	var sorting *paginationSort
	if signature, sorted := prepared.sortSignature.Get(); sorted {
		sorting = &paginationSort{signature: signature, directions: results.SortDirectionsOf(params.Sort), sortKeyOf: sortKeyOf}
	}
	var pinnedIDs map[string]struct{}
	if params.Pinned != nil && !params.SearchAfter.IsSet() {
		pinnedIDs = make(map[string]struct{}, len(params.Pinned))
		for _, entry := range params.Pinned {
			pinnedIDs[entry.DocID] = struct{}{}
		}
	}
	var page pageOfHits
	if found.paginate != nil {
		page = found.paginate(hits, pinnedIDs)
	} else {
		searchAfter, _ := params.SearchAfter.Get()
		paged, err := applyPagination(hits, prepared.limit, prepared.offset, prepared.binding, searchAfter, sorting, pinnedIDs, ix.omitsCursorDepth(prepared))
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
				Values:       group.Values,
				Hits:         ix.projectedHits(group.Hits, prepared, documents, dropsScores),
				Reduced:      group.Reduced,
				ReducerError: group.ReducerError.Or(""),
			}
		}
	}
	return shapedResult{result: result, documents: documents}, nil
}

func (ix *Index) omitsCursorDepth(prepared *preparedQuery) bool {
	params := &prepared.params
	return prepared.sortSignature.IsSet() && !isBlank(params.Term) && !prepared.vectorOnly && !prepared.hybrid && !params.IncludeScores && !params.IncludeScoreComponents &&
		!params.MinScore.IsSet() && params.Group == nil && params.Pinned == nil && !termMatchFilters(params.TermMatch)
}

func (ix *Index) projectedHits(hits []results.Hit, prepared *preparedQuery, documents *documentLookup, dropsScores bool) []model.Hit {
	projected := make([]model.Hit, len(hits))
	for at, hit := range hits {
		shown := model.Hit{ID: hit.ID, Score: hit.Score, ScoreComponents: hit.Components, Document: model.Document{}}
		if dropsScores {
			shown.Score = model.Optional[float64]{}
		}
		if prepared.projection.Kind() != model.ProjectNoFields {
			if stored := documents.stored(hit.ID); stored != nil {
				shown.Document = prepared.projection.Clone(stored.Fields)
			}
		}
		projected[at] = shown
	}
	return projected
}
