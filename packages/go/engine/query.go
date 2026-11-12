package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (entry *indexEntry) attachHitVectors(ctx context.Context, result *model.QueryResult,
	requested model.DocumentProjection) error {
	if len(entry.vectorPaths) == 0 {
		return nil
	}
	shown := projection.Resolve(requested)
	for _, hit := range result.Hits {
		if err := entry.attachVectorsUnder(ctx, hit.Document, hit.ID, shown); err != nil {
			return err
		}
	}
	for _, group := range result.Groups {
		for _, hit := range group.Hits {
			if err := entry.attachVectorsUnder(ctx, hit.Document, hit.ID, shown); err != nil {
				return err
			}
		}
	}
	return nil
}

func (n *Narsil) queryPinned(ctx context.Context, entry *indexEntry, target *index.Index, resolved model.QueryParams,
	options index.QueryOptions) (model.QueryResult, error) {
	pinned, unpin, err := target.Pin(ctx)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer unpin()
	result, err := target.QueryWith(pinned, resolved, options)
	if err != nil {
		return model.QueryResult{}, err
	}
	if err := entry.attachHitVectors(pinned, &result, resolved.Document); err != nil {
		return model.QueryResult{}, err
	}
	return result, nil
}

func (n *Narsil) prepareSearch(ctx context.Context, entry *indexEntry, params model.QueryParams) (model.QueryParams, index.QueryOptions, error) {
	if err := index.RequireUsableVectorSettings(&params); err != nil {
		return params, index.QueryOptions{}, err
	}
	params, err := n.beforeSearch(ctx, entry.name, params)
	if err != nil {
		return params, index.QueryOptions{}, err
	}
	options := index.QueryOptions{CursorParams: model.Some(params), PhraseReady: entry.phraseReady}
	return index.WithRerankQueryText(params), options, nil
}

func (n *Narsil) beforeSearch(ctx context.Context, indexName string, params model.QueryParams) (model.QueryParams, error) {
	if !n.plugins.hasBeforeSearchHooks() {
		return params, nil
	}
	hooked := params
	err := n.plugins.search(ctx, hookBeforeSearch, &model.SearchContext{IndexName: indexName, Params: &hooked})
	return hooked, err
}

func (n *Narsil) afterSearch(ctx context.Context, indexName string, params model.QueryParams, result model.QueryResult) {
	if !n.plugins.hasAfterSearchHooks() {
		return
	}
	observed := result
	observed.Hits = append([]model.Hit(nil), result.Hits...)
	_ = n.plugins.search(ctx, hookAfterSearch, &model.SearchContext{IndexName: indexName, Params: &params, Results: &observed})
}

// Query searches the index called indexName and returns one page of ranked
// hits with the match count, facets, groups, and the cursor for the next
// page. params.Mode picks keyword, vector, or hybrid search; a vector clause
// with Text set is embedded with the index's adapter first. Plugins' search
// hooks run around the query. It returns a search code for an invalid query,
// such as CodeSearchInvalidField for a field that the schema does not
// declare, and an embedding code when the query text cannot be embedded.
//
// The engine calls the embedding adapter and the rerank adapter while it
// holds no lock on the index, so an adapter can query or restore the index
// that the query reads. When a restore puts another embedding adapter on the
// index during the embedding, the engine embeds the text again with that
// adapter, and when a restore replaces the index during the rerank call, the
// query runs again on the restored index. A rebalance or an analysis change
// during the rerank call also runs the query again, on the index that it put
// in place. The query returns CodeWorkerBusy once the adapter has changed
// after three embeddings, or once a restore, a drop, or a close has replaced
// the index during each of three rerank calls, while the reruns after a
// rebalance or an analysis change count toward no limit.
func (n *Narsil) Query(ctx context.Context, indexName string, params QueryParams) (QueryResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.QueryResult{}, err
	}
	hooked, options, err := n.prepareSearch(ctx, entry, params)
	if err != nil {
		release()
		return model.QueryResult{}, err
	}
	result, resolved, release, err := n.answerQuery(ctx, indexName, entry, release, hooked, options)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer release()
	n.afterSearch(ctx, indexName, resolved, result)
	return result, nil
}

// Preflight counts the documents that a query matches without building any
// hits, so that a caller can show a match count before it runs the query.
// It validates params the same way Query does, and it embeds a vector
// clause's Text the same way, with no lock held on the index during the
// embedding.
func (n *Narsil) Preflight(ctx context.Context, indexName string, params QueryParams) (PreflightResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.PreflightResult{}, err
	}
	hooked, options, err := n.prepareSearch(ctx, entry, params)
	if err != nil {
		release()
		return model.PreflightResult{}, err
	}
	entry, release, embedded, err := n.embedForQuery(ctx, indexName, entry, release, hooked, nil)
	if err != nil {
		return model.PreflightResult{}, err
	}
	defer release()
	result, stale, err := readUnderOneAnalysis(ctx, n, entry, func(target *index.Index) (model.PreflightResult, error) {
		return target.PreflightWith(ctx, embedded.params, index.QueryOptions{PhraseReady: options.PhraseReady})
	})
	if err != nil {
		return model.PreflightResult{}, err
	}
	result.AnalysisStale = stale
	return result, nil
}

func readUnderOneAnalysis[R any](ctx context.Context, n *Narsil, entry *indexEntry, read func(*index.Index) (R, error)) (R, bool, error) {
	return readUnderOneAnalysisDiscarding(ctx, n, entry, read, nil)
}

func readUnderOneAnalysisDiscarding[R any](ctx context.Context, n *Narsil, entry *indexEntry, read func(*index.Index) (R, error),
	discard func(R)) (R, bool, error) {
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
		if err == nil && discard != nil {
			discard(result)
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, false, ctxErr
		}
	}
}
