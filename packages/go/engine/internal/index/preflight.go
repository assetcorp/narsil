package index

import (
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) Preflight(request model.QueryParams) (model.PreflightResult, error) {
	return ix.PreflightWith(request, QueryOptions{})
}

func (ix *Index) PreflightWith(request model.QueryParams, options QueryOptions) (model.PreflightResult, error) {
	started := time.Now()
	if err := requireKnownMode(&request); err != nil {
		return model.PreflightResult{}, err
	}
	if err := RequireUsableVectorSettings(&request); err != nil {
		return model.PreflightResult{}, err
	}
	work := partition.NewWorkMeter(ix.settings.SearchWorkCap)
	filter, err := ix.validQueryParams(&request, work)
	if err != nil {
		return model.PreflightResult{}, err
	}
	modes := searchModesOf(&request)
	if err := ix.requireUsableVectorClause(&request, modes); err != nil {
		return model.PreflightResult{}, err
	}
	prepared := &preparedQuery{
		params:      request,
		limit:       cursor.ClampLimit(request.Limit),
		offset:      cursor.ClampOffset(request.Offset),
		binding:     cursor.LazyQueryBinding(request),
		work:        work,
		filter:      filter,
		bm25:        mergeBM25Levels(&request.BM25, ix.BM25()),
		vectorOnly:  modes.vectorOnly,
		hybrid:      modes.hybrid,
		phraseReady: options.PhraseReady,
	}
	pass, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return model.PreflightResult{}, err
	}
	if err := ix.analyseQueryTerm(prepared, pass); err != nil {
		return model.PreflightResult{}, err
	}
	var found fanOutResult
	switch {
	case modes.vectorOnly:
		prepared.limit, prepared.offset = preflightLimit, 0
		found, err = ix.vectorRanked(prepared, 0)
	case modes.hybrid:
		prepared.limit, prepared.offset = preflightLimit, 0
		found, err = ix.hybridRanked(prepared, pass, 0)
	default:
		found, err = ix.textRanked(prepared, pass)
	}
	if err != nil {
		return model.PreflightResult{}, err
	}
	return model.PreflightResult{Count: found.totalMatched, CountExact: !found.inexact, Elapsed: time.Since(started)}, nil
}
