package index

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) QueryReranked(ctx context.Context, request model.QueryParams, maxWindow int, score RerankScorer,
	options QueryOptions) (model.QueryResult, error) {
	started := time.Now()
	if err := RequireUsableVectorSettings(&request); err != nil {
		return model.QueryResult{}, err
	}
	ctx, unpin, err := ix.Pin(ctx)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer unpin()
	binding := options.Binding
	if binding == nil {
		binding = cursor.LazyQueryBinding(request)
	}
	hybridDepth := model.Optional[int]{}
	if rerankFusesRankings(&request) {
		depth, set, err := fixedHybridDepth(request.Hybrid)
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
	var pins []query.Pin
	if placesPins {
		if pins, err = ix.storedPins(ctx, request.Pinned); err != nil {
			return model.QueryResult{}, err
		}
	}
	place := func(hits []model.Hit) ([]resultHit, error) {
		converted := toResultHits(hits)
		if !placesPins {
			return converted, nil
		}
		placed, _, err := placePinned(converted, pins)
		return placed, err
	}
	start := cursorDepth + offset
	windowSize := min(plan.window, len(ranked))
	placedRanked, err := place(ranked)
	if err != nil {
		return model.QueryResult{}, err
	}
	pageHoldsHits := limit > 0 && start < len(placedRanked)
	window := positionPage{start: start, limit: limit}
	if placesPins {
		window.pinnedIDs = model.Some(pinnedIDsOf(pins))
	}
	documents, err := ix.documentsKeptThroughRerank(ctx, rerankedPageReach(ranked, windowSize, window, pins, first.Groups))
	if err != nil {
		return model.QueryResult{}, err
	}
	ordered := ranked
	if windowSize > 0 && pageHoldsHits {
		scores, err := score(ctx, plan.adapter, plan.query, rerankTexts(documents, ranked[:windowSize], plan.fields))
		if err != nil {
			return model.QueryResult{}, err
		}
		ordered = reorderByRerank(ranked, windowSize, scores)
	} else if _, err := score(ctx, plan.adapter, plan.query, []string{}); err != nil {
		return model.QueryResult{}, err
	}
	organic := make([]string, len(ordered))
	for at, hit := range ordered {
		organic[at] = hit.ID
	}
	placedOrdered, err := place(ordered)
	if err != nil {
		return model.QueryResult{}, err
	}
	pageHits, next := pageByPosition(placedOrdered, organic, window)
	page := toModelHits(pageHits)
	fillRerankedDocuments(documents, page, first.Groups, request.Document)
	if request.Highlight != nil {
		if err := ix.highlightReranked(documents, page, request); err != nil {
			return model.QueryResult{}, err
		}
	}
	result := model.QueryResult{Hits: page, Count: counted.Count, CountExact: counted.CountExact, Facets: first.Facets,
		Groups: first.Groups, Coverage: first.Coverage}
	if next != nil {
		result.Cursor = cursor.EncodePageCursor(cursor.PageCursor{Anchor: next.anchor, Score: next.score, Depth: next.depth,
			Binding: binding()})
	}
	result.Elapsed = time.Since(started)
	return result, nil
}
