package index

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) QueryReranked(ctx context.Context, request model.QueryParams, maxWindow int, score RerankScorer,
	options QueryOptions) (model.QueryResult, error) {
	started := time.Now()
	if err := RequireUsableVectorSettings(&request); err != nil {
		return model.QueryResult{}, err
	}
	binding := options.Binding
	if binding == nil {
		binding = cursor.LazyQueryBinding(request)
	}
	hybridDepth := model.Optional[int]{}
	if rerankFusesRankings(&request) {
		depth, set, err := results.FixedHybridDepth(request.Hybrid)
		if err != nil {
			return model.QueryResult{}, err
		}
		if set {
			hybridDepth = model.Some(depth)
		}
	}
	plan, err := ix.resolveRerankPlan(&request, maxWindow, hybridDepth)
	if err != nil {
		return model.QueryResult{}, err
	}
	limit, offset := cursor.ClampLimit(request.Limit), cursor.ClampOffset(request.Offset)
	cursorDepth, err := ix.rerankCursorDepth(&request, binding)
	if err != nil {
		return model.QueryResult{}, err
	}
	depth, err := rerankFirstStageDepth(hybridDepth, plan.window, cursorDepth, offset, limit)
	if err != nil {
		return model.QueryResult{}, err
	}
	firstParams := request
	firstParams.Rerank, firstParams.Pinned, firstParams.SearchAfter, firstParams.Highlight = nil, nil, model.Optional[string]{}, nil
	firstParams.Document = model.NoDocumentFields()
	stage := firstParams
	stage.Offset, stage.Limit = 0, model.Some(depth)
	first, err := ix.QueryWith(ctx, stage, QueryOptions{PhraseReady: options.PhraseReady})
	if err != nil {
		return model.QueryResult{}, err
	}
	placesPins := !request.SearchAfter.IsSet() && request.Pinned != nil
	counted := first
	if placesPins || (request.Vector != nil && !rerankFusesRankings(&request)) {
		plain := firstParams
		if placesPins {
			plain.Pinned = request.Pinned
		}
		plain.Facets, plain.Group = nil, nil
		plain.Offset, plain.Limit = cursorDepth+offset, model.Some(limit)
		if counted, err = ix.QueryContext(ctx, plain); err != nil {
			return model.QueryResult{}, err
		}
	}
	ranked := first.Hits
	var pins []model.PinnedDocument
	if placesPins {
		pins = ix.storedPins(request.Pinned)
	}
	place := func(hits []model.Hit) []results.Hit {
		converted := toResultHits(hits)
		if !placesPins {
			return converted
		}
		placed, _ := results.PlacePinned(converted, pins, func(id string) (results.Hit, bool) {
			return results.Hit{ID: id, Score: model.Some(0.0)}, true
		})
		return placed
	}
	start := cursorDepth + offset
	windowSize := min(plan.window, len(ranked))
	pageHoldsHits := limit > 0 && start < len(place(ranked))
	ordered := ranked
	if windowSize > 0 && pageHoldsHits {
		scores, err := score(ctx, plan.adapter, plan.query, ix.rerankTexts(ranked[:windowSize], plan.fields))
		if err != nil {
			return model.QueryResult{}, err
		}
		ordered = reorderByRerank(ranked, windowSize, scores)
	} else if _, err := score(ctx, plan.adapter, plan.query, []string{}); err != nil {
		return model.QueryResult{}, err
	}
	window := results.PositionPage{Start: start, Limit: limit}
	if placesPins {
		pinnedIDs := make(map[string]struct{}, len(pins))
		for _, entry := range pins {
			pinnedIDs[entry.DocID] = struct{}{}
		}
		window.PinnedIDs = model.Some(pinnedIDs)
	}
	organic := make([]string, len(ordered))
	for at, hit := range ordered {
		organic[at] = hit.ID
	}
	pageHits, next := results.PageByPosition(place(ordered), organic, window)
	page := toModelHits(pageHits)
	ix.fillRerankedDocuments(page, first.Groups, request.Document)
	if request.Highlight != nil {
		if err := ix.highlightReranked(page, request); err != nil {
			return model.QueryResult{}, err
		}
	}
	result := model.QueryResult{Hits: page, Count: counted.Count, CountExact: counted.CountExact, Facets: first.Facets,
		Groups: first.Groups, Coverage: first.Coverage}
	if next != nil {
		result.Cursor = cursor.EncodePageCursor(cursor.PageCursor{Anchor: next.Anchor, Score: next.Score, Depth: next.Depth,
			Binding: binding()})
	}
	result.Elapsed = time.Since(started)
	return result, nil
}
