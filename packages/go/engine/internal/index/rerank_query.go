package index

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type RerankStage struct {
	ix         *Index
	started    time.Time
	request    model.QueryParams
	binding    *cursor.QueryBinding
	plan       rerankPlan
	ranked     []model.Hit
	windowSize int
	placesPins bool
	pins       []query.Pin
	window     positionPage
	documents  *documentLookup
	first      model.QueryResult
	counted    model.QueryResult
	texts      []string
	awaits     bool
}

func (ix *Index) StageReranked(pinned context.Context, request model.QueryParams, maxWindow int,
	options QueryOptions) (*RerankStage, error) {
	started := time.Now()
	if err := RequireUsableVectorSettings(&request); err != nil {
		return nil, err
	}
	binding := cursor.NewQueryBinding(options.CursorParams.Or(request))
	hybridDepth := model.Optional[int]{}
	if rerankFusesRankings(&request) {
		depth, set, err := fixedHybridDepth(request.Hybrid)
		if err != nil {
			return nil, err
		}
		if set {
			hybridDepth = model.Some(depth)
		}
	}
	plan, err := ix.resolveRerankPlan(&request, maxWindow, hybridDepth)
	if err != nil {
		return nil, err
	}
	limit, offset := cursor.ClampLimit(request.Limit), cursor.ClampOffset(request.Offset)
	cursorDepth, err := ix.rerankCursorDepth(&request, binding)
	if err != nil {
		return nil, err
	}
	depth, err := rerankFirstStageDepth(hybridDepth, plan.window, cursorDepth, offset, limit)
	if err != nil {
		return nil, err
	}
	firstParams := request
	firstParams.Rerank, firstParams.Pinned, firstParams.SearchAfter, firstParams.Highlight = nil, nil, model.Optional[string]{}, nil
	firstParams.Document = model.NoDocumentFields()
	stage := firstParams
	stage.Offset, stage.Limit = 0, model.Some(depth)
	first, err := ix.QueryWith(pinned, stage, QueryOptions{PhraseReady: options.PhraseReady})
	if err != nil {
		return nil, err
	}
	staged := &RerankStage{ix: ix, started: started, request: request, binding: binding, plan: plan, first: first,
		counted: first, ranked: first.Hits, placesPins: !request.SearchAfter.IsSet() && request.Pinned != nil}
	if staged.placesPins || (request.Vector != nil && !rerankFusesRankings(&request)) {
		plain := firstParams
		if staged.placesPins {
			plain.Pinned = request.Pinned
		}
		plain.Facets, plain.Group = nil, nil
		plain.Offset, plain.Limit = cursorDepth+offset, model.Some(limit)
		if staged.counted, err = ix.QueryContext(pinned, plain); err != nil {
			return nil, err
		}
	}
	if staged.placesPins {
		if staged.pins, err = ix.storedPins(pinned, request.Pinned); err != nil {
			return nil, err
		}
	}
	start := cursorDepth + offset
	staged.windowSize = min(plan.window, len(staged.ranked))
	placedRanked, err := staged.place(staged.ranked)
	if err != nil {
		return nil, err
	}
	pageHoldsHits := limit > 0 && start < len(placedRanked)
	staged.window = positionPage{start: start, limit: limit}
	if staged.placesPins {
		staged.window.pinnedIDs = model.Some(pinnedIDsOf(staged.pins))
	}
	staged.documents, err = ix.documentsKeptThroughRerank(pinned,
		rerankedPageReach(staged.ranked, staged.windowSize, staged.window, staged.pins, first.Groups))
	if err != nil {
		return nil, err
	}
	if staged.windowSize > 0 && pageHoldsHits {
		staged.texts = rerankTexts(staged.documents, staged.ranked[:staged.windowSize], plan.fields)
		staged.awaits = true
	}
	return staged, nil
}

func (s *RerankStage) place(hits []model.Hit) ([]resultHit, error) {
	converted := toResultHits(hits)
	if !s.placesPins {
		return converted, nil
	}
	placed, _, err := placePinned(converted, s.pins)
	return placed, err
}

func (s *RerankStage) AwaitsScores() bool {
	return s.awaits
}

func (s *RerankStage) Score(ctx context.Context, score RerankScorer) ([]float64, error) {
	texts := s.texts
	if !s.awaits {
		texts = []string{}
	}
	return score(ctx, s.plan.adapter, s.plan.query, texts)
}

func (s *RerankStage) Finish(scores []float64) (model.QueryResult, error) {
	ordered := s.ranked
	if s.awaits {
		ordered = reorderByRerank(s.ranked, s.windowSize, scores)
	}
	organic := make([]string, len(ordered))
	for at, hit := range ordered {
		organic[at] = hit.ID
	}
	placedOrdered, err := s.place(ordered)
	if err != nil {
		return model.QueryResult{}, err
	}
	pageHits, next := pageByPosition(placedOrdered, organic, s.window)
	page := toModelHits(pageHits)
	fillRerankedDocuments(s.documents, page, s.first.Groups, s.request.Document)
	if s.request.Highlight != nil {
		if err := s.ix.highlightReranked(s.documents, page, s.request); err != nil {
			return model.QueryResult{}, err
		}
	}
	result := model.QueryResult{Hits: page, Count: s.counted.Count, CountExact: s.counted.CountExact, Facets: s.first.Facets,
		Groups: s.first.Groups, Coverage: s.first.Coverage}
	if next != nil {
		result.Cursor = cursor.EncodePageCursor(cursor.PageCursor{Anchor: next.anchor, Score: next.score, Depth: next.depth,
			Binding: s.binding.Text()})
	}
	result.Elapsed = time.Since(s.started)
	return result, nil
}
