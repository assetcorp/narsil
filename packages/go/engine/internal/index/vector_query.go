package index

import (
	"context"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type VectorHit struct {
	ID    string
	Score float64
}

type VectorOutcome struct {
	Hits         []VectorHit
	Matched      int
	MatchedExact bool
}

func (o VectorOutcome) holdsEveryMatch() bool {
	return o.MatchedExact && len(o.Hits) == o.Matched
}

type VectorRequest struct {
	Config        *model.VectorQueryConfig
	K             int
	RescoreWindow int
	Filtered      bool
	AcceptedIDs   []string
}

type VectorSearcher interface {
	SearchVectors(ctx context.Context, request VectorRequest) (VectorOutcome, error)
}

type VectorFields interface {
	VectorSearcher(field string) (VectorSearcher, bool)
	VectorFieldNames() []string
}

type vectorAcceptance struct {
	filtered bool
	ids      []string
}

func (a vectorAcceptance) matchesNothing() bool {
	return a.filtered && len(a.ids) == 0
}

func (ix *Index) vectorSearcherOf(field string) (VectorSearcher, bool) {
	if ix.settings.Vectors == nil {
		return nil, false
	}
	return ix.settings.Vectors.VectorSearcher(field)
}

func (ix *Index) vectorFieldNames() []string {
	if ix.settings.Vectors == nil {
		return []string{}
	}
	return append([]string{}, ix.settings.Vectors.VectorFieldNames()...)
}

func (ix *Index) requireVectorSearchable(query *model.QueryParams, needsVector bool) error {
	if !needsVector {
		return nil
	}
	if query.Vector == nil || query.Vector.Field == "" {
		return narsilerr.New(narsilerr.CodeSearchInvalidMode,
			`A "`+string(query.Mode)+`" query needs a vector clause naming the field to search`,
			map[string]any{"mode": string(query.Mode)})
	}
	if _, found := ix.vectorSearcherOf(query.Vector.Field); found {
		return nil
	}
	return narsilerr.New(narsilerr.CodeSearchInvalidField,
		`Field "`+query.Vector.Field+`" has no vector index, so a vector search cannot use it`,
		map[string]any{"field": query.Vector.Field, "vectorFields": ix.vectorFieldNames()})
}

func RequireUsableVectorSettings(query *model.QueryParams) error {
	if query.Vector == nil {
		return nil
	}
	if err := requireUsableEfSearch(query.Vector); err != nil {
		return err
	}
	return requireUsableOversample(query.Vector)
}

func requireUsableEfSearch(config *model.VectorQueryConfig) error {
	efSearch, set := config.EfSearch.Get()
	if !set || efSearch >= MinEfSearch && efSearch <= MaxEfSearch {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		"vector.efSearch must be a whole number from "+strconv.Itoa(MinEfSearch)+" to "+strconv.Itoa(MaxEfSearch)+", and this query gives "+strconv.Itoa(efSearch),
		map[string]any{"efSearch": efSearch, "minimum": MinEfSearch, "maximum": MaxEfSearch})
}

func requireUsableOversample(config *model.VectorQueryConfig) error {
	oversample, set := config.Oversample.Get()
	if !set || !math.IsNaN(oversample) && !math.IsInf(oversample, 0) && oversample >= MinOversample {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		"vector.oversample must be a finite number of at least "+strconv.Itoa(MinOversample),
		map[string]any{"oversample": oversample})
}

func requireUsableQueryVector(query *model.QueryParams) error {
	if query.Vector == nil || query.Vector.Value == nil {
		return nil
	}
	for at, element := range query.Vector.Value {
		widened := float64(element)
		if !math.IsNaN(widened) && !math.IsInf(widened, 0) {
			continue
		}
		return narsilerr.New(narsilerr.CodeDocValidationFailed,
			"Vector query 'value' element at index "+strconv.Itoa(at)+" is not a number that a 32-bit float holds as a finite value",
			map[string]any{"index": at, "value": widened})
	}
	return nil
}

func vectorFetchDepth(limit, offset, cursorDepth int) (int, error) {
	reach := float64(cursorDepth) + float64(offset) + float64(limit)
	if reach > cursor.ResultWindow {
		return 0, narsilerr.New(narsilerr.CodeSearchResultWindowExceeded,
			"The engine pages a vector search through the first "+strconv.Itoa(cursor.ResultWindow)+" results, and this page ends at "+
				text.FormatNumber(reach)+". Narrow the search with a filter or a similarity floor",
			map[string]any{"limit": limit, "offset": offset, "cursorDepth": cursorDepth, "window": cursor.ResultWindow})
	}
	return min(int(reach)+1, cursor.ResultWindow), nil
}

func (ix *Index) cursorDepthOf(prepared *preparedQuery) (int, error) {
	encoded, set := prepared.params.SearchAfter.Get()
	if !set {
		return 0, nil
	}
	decoded, err := cursor.DecodePageCursor(encoded)
	if err != nil {
		return 0, err
	}
	if err := cursor.RequireMatchingCursor(decoded, encoded, prepared.sortSignature, true, prepared.binding()); err != nil {
		return 0, err
	}
	return decoded.Depth, nil
}

func (ix *Index) acceptedForVectors(prepared *preparedQuery) (vectorAcceptance, error) {
	if prepared.filters == nil {
		return vectorAcceptance{}, nil
	}
	views, err := prepared.reads.views.all()
	if err != nil {
		return vectorAcceptance{}, err
	}
	accepted := vectorAcceptance{filtered: true, ids: []string{}}
	for at, snapshot := range prepared.reads.reading.Snapshots {
		matched, err := prepared.filters.evaluate(views[at])
		if err != nil {
			return vectorAcceptance{}, err
		}
		accepted.ids = append(accepted.ids, matchingIDs(snapshot, matched)...)
	}
	return accepted, nil
}

func scoredOfVectorHits(hits []VectorHit) []scoredHit {
	scored := make([]scoredHit, len(hits))
	for at, hit := range hits {
		scored[at] = scoredHit{ID: hit.ID, Score: hit.Score}
	}
	return scored
}

func (ix *Index) searchVectorLeg(ctx context.Context, config *model.VectorQueryConfig, k, rescoreWindow int, accepted vectorAcceptance) (VectorOutcome, error) {
	searcher, found := ix.vectorSearcherOf(config.Field)
	if !found {
		return VectorOutcome{Hits: []VectorHit{}, MatchedExact: true}, nil
	}
	return searcher.SearchVectors(ctx, VectorRequest{Config: config, K: k, RescoreWindow: rescoreWindow, Filtered: accepted.filtered, AcceptedIDs: accepted.ids})
}

func (ix *Index) vectorRanked(prepared *preparedQuery, cursorDepth int) (fanOutResult, error) {
	config := prepared.params.Vector
	if config == nil || config.Value == nil {
		return fanOutResult{}, nil
	}
	if _, found := ix.vectorSearcherOf(config.Field); !found {
		return fanOutResult{}, nil
	}
	accepted, err := ix.acceptedForVectors(prepared)
	if err != nil || accepted.matchesNothing() {
		return fanOutResult{}, err
	}
	k, err := vectorFetchDepth(prepared.limit, prepared.offset, cursorDepth)
	if err != nil {
		return fanOutResult{}, err
	}
	outcome, err := ix.searchVectorLeg(prepared.context(), config, k, 0, accepted)
	if err != nil {
		return fanOutResult{}, err
	}
	return fanOutResult{scored: scoredOfVectorHits(outcome.Hits), totalMatched: outcome.Matched, inexact: !outcome.MatchedExact}, nil
}
