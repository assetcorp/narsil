package engine

import (
	"context"
	"fmt"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (entry *indexEntry) embedQueryText(ctx context.Context, params model.QueryParams) (model.QueryParams, error) {
	vector := params.Vector
	if vector == nil {
		return params, nil
	}
	text, hasText := vector.Text.Get()
	if !hasText {
		return params, nil
	}
	if vector.Value != nil {
		return params, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid, "Vector query cannot have both 'text' and 'value'", nil)
	}
	adapter := entry.boundEmbedder()
	if adapter == nil {
		if entry.embeddingName != "" {
			return params, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
				fmt.Sprintf("Vector query with 'text' needs embedding adapter %q, which is not registered on this engine. Register it with RegisterEmbeddingAdapter or supply a raw vector.", entry.embeddingName),
				map[string]any{"adapter": entry.embeddingName})
		}
		return params, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
			"Vector query with 'text' requires an embedding adapter on the index or instance", nil)
	}
	if text == "" {
		return params, narsilerr.New(narsilerr.CodeDocValidationFailed, "Vector query 'text' must not be empty", nil)
	}
	embedder := safeEmbedder{adapter: adapter}
	raw, err := embedder.Embed(ctx, text, model.EmbeddingForQuery)
	if err != nil {
		if _, isEngineError := narsilerr.As(err); isEngineError {
			return params, err
		}
		return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
			"The embedding adapter cannot embed the query: "+err.Error(), map[string]any{"cause": err.Error()})
	}
	if raw == nil {
		return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
			"Adapter returned undefined for query embedding, expected Float32Array", nil)
	}
	dimensions := embedder.Dimensions()
	if len(raw) != dimensions {
		return params, narsilerr.New(narsilerr.CodeEmbeddingDimensionMismatch,
			fmt.Sprintf("Adapter returned %d-dimensional vector for query, expected %d", len(raw), dimensions),
			map[string]any{"expected": dimensions, "actual": len(raw)})
	}
	for at, value := range raw {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
				fmt.Sprintf("Adapter returned vector with %s at index %d for query embedding", formatNonFinite(value), at),
				map[string]any{"index": at})
		}
	}
	resolved := *vector
	resolved.Value = append([]float32(nil), raw...)
	resolved.Text = model.Optional[string]{}
	params.Vector = &resolved
	return params, nil
}

func (entry *indexEntry) attachHitVectors(ctx context.Context, result *model.QueryResult,
	requested model.DocumentProjection) {
	if len(entry.vectorPaths) == 0 {
		return
	}
	shown := projection.Resolve(requested)
	for _, hit := range result.Hits {
		entry.attachVectorsUnder(ctx, hit.Document, hit.ID, shown)
	}
	for _, group := range result.Groups {
		for _, hit := range group.Hits {
			entry.attachVectorsUnder(ctx, hit.Document, hit.ID, shown)
		}
	}
}

func (n *Narsil) prepareSearch(ctx context.Context, entry *indexEntry, params model.QueryParams) (model.QueryParams, index.QueryOptions, error) {
	if err := index.RequireUsableVectorSettings(&params); err != nil {
		return params, index.QueryOptions{}, err
	}
	search := &model.SearchContext{IndexName: entry.name, Params: &params}
	if err := n.plugins.search(ctx, hookBeforeSearch, search); err != nil {
		return params, index.QueryOptions{}, err
	}
	options := index.QueryOptions{Binding: cursor.LazyQueryBinding(params),
		PhraseReady: func() error { return n.requirePhraseReady(entry) }}
	resolved, err := entry.embedQueryText(ctx, index.WithRerankQueryText(params))
	return resolved, options, err
}

// Query searches the index called indexName and returns one page of ranked
// hits with the match count, facets, groups, and the cursor for the next
// page. params.Mode picks keyword, vector, or hybrid search; a vector clause
// with Text set is embedded with the index's adapter first. Plugins' search
// hooks run around the query. It returns a search code for an invalid query,
// such as CodeSearchInvalidField for a field that the schema does not
// declare, and an embedding code when the query text cannot be embedded.
func (n *Narsil) Query(ctx context.Context, indexName string, params QueryParams) (QueryResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer release()
	resolved, options, err := n.prepareSearch(ctx, entry, params)
	if err != nil {
		return model.QueryResult{}, err
	}
	ctx, unpin, err := entry.pinVectors(ctx, resolved.Vector != nil)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer unpin()
	result, stale, err := readUnderOneAnalysis(ctx, n, entry, func(target *index.Index) (model.QueryResult, error) {
		if resolved.Rerank != nil {
			return target.QueryReranked(ctx, resolved, n.rerank.maxWindow, n.rerankScorer, options)
		}
		return target.QueryWith(ctx, resolved, options)
	})
	if err != nil {
		return model.QueryResult{}, err
	}
	result.AnalysisStale = stale
	entry.attachHitVectors(ctx, &result, resolved.Document)
	observed := result
	observed.Hits = append([]model.Hit(nil), result.Hits...)
	_ = n.plugins.search(ctx, hookAfterSearch, &model.SearchContext{IndexName: indexName, Params: &resolved, Results: &observed})
	return result, nil
}

// Preflight counts the documents that a query matches without building any
// hits, so that a caller can show a match count before it runs the query.
// It validates params the same way Query does.
func (n *Narsil) Preflight(ctx context.Context, indexName string, params QueryParams) (PreflightResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.PreflightResult{}, err
	}
	defer release()
	resolved, options, err := n.prepareSearch(ctx, entry, params)
	if err != nil {
		return model.PreflightResult{}, err
	}
	result, stale, err := readUnderOneAnalysis(ctx, n, entry, func(target *index.Index) (model.PreflightResult, error) {
		return target.PreflightWith(resolved, index.QueryOptions{PhraseReady: options.PhraseReady})
	})
	if err != nil {
		return model.PreflightResult{}, err
	}
	result.AnalysisStale = stale
	return result, nil
}

func readUnderOneAnalysis[R any](ctx context.Context, n *Narsil, entry *indexEntry, read func(*index.Index) (R, error)) (R, bool, error) {
	for {
		target := entry.index()
		stale := entry.analysisIsStale()
		var result R
		err := n.workers.run(ctx, entry, func() error {
			var readErr error
			result, readErr = read(target)
			return readErr
		})
		unchanged := entry.index() == target
		if err != nil && unchanged {
			return result, false, queryTokensRefused(err)
		}
		if err == nil && unchanged && entry.analysisIsStale() == stale {
			return result, stale, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, false, ctxErr
		}
	}
}
