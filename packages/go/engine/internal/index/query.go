package index

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type preparedQuery struct {
	params        model.QueryParams
	limit         int
	offset        int
	sortSignature model.Optional[string]
	bm25          *model.BM25Params
	work          *core.WorkMeter
	closeWork     func()
	binding       func() string
	projection    projection.Projection
	filters       *filterRun
	reads         *queryReads
	term          *analysedTerm
	vectorOnly    bool
	hybrid        bool
	ctx           context.Context
	phraseReady   func() error
}

func (q *preparedQuery) context() context.Context {
	if q.ctx == nil {
		return context.Background()
	}
	return q.ctx
}

func (q *preparedQuery) close() {
	if q.reads != nil {
		q.reads.release()
		q.reads = nil
	}
	if q.closeWork != nil {
		q.closeWork()
		q.work, q.closeWork = nil, nil
	}
}

type searchModes struct {
	hasVector  bool
	hybrid     bool
	vectorOnly bool
}

func searchModesOf(request *model.QueryParams) searchModes {
	hasTerm := !isBlank(request.Term)
	hasVector := request.Vector != nil && request.Vector.Value != nil
	hybrid := request.Mode == model.SearchHybrid || hasTerm && hasVector
	vectorOnly := (request.Mode == model.SearchVector || hasVector && !hasTerm) && !hybrid
	return searchModes{hasVector: hasVector, hybrid: hybrid, vectorOnly: vectorOnly}
}

func sortFieldNames(fields []model.SortField) []string {
	names := make([]string, len(fields))
	for at, entry := range fields {
		names[at] = entry.Field
	}
	return names
}

func groupFieldsOf(params *model.QueryParams) []string {
	if params.Group == nil {
		return nil
	}
	return params.Group.Fields
}

func (ix *Index) prepareQuery(request model.QueryParams) (*preparedQuery, error) {
	prepared := &preparedQuery{
		limit:   cursor.ClampLimit(request.Limit),
		offset:  cursor.ClampOffset(request.Offset),
		binding: cursor.LazyQueryBinding(request),
	}
	if err := cursor.RequireWithinResultWindow(prepared.limit, prepared.offset); err != nil {
		return nil, err
	}
	if err := requireKnownMode(&request); err != nil {
		return nil, err
	}
	if err := RequireUsableVectorSettings(&request); err != nil {
		return nil, err
	}
	signature, err := cursor.SortSignatureOf(request.Sort)
	if err != nil {
		return nil, err
	}
	prepared.sortSignature = signature
	modes := searchModesOf(&request)
	if signature.IsSet() && (modes.hybrid || request.Hybrid != nil) {
		return nil, narsilerr.New(narsilerr.CodeSearchInvalidMode,
			"A hybrid query cannot carry a sort, because fusion defines the order of hybrid results",
			map[string]any{"sort": sortFieldNames(request.Sort)})
	}
	if err := ix.validQueryParams(&request); err != nil {
		return nil, err
	}
	if err := ix.requireUsableVectorClause(&request, modes); err != nil {
		return nil, err
	}
	prepared.vectorOnly, prepared.hybrid = modes.vectorOnly, modes.hybrid
	prepared.params = request
	prepared.bm25 = mergeBM25Levels(&request.BM25, ix.BM25())
	prepared.projection = projection.Resolve(request.Document)
	return prepared, nil
}

func (ix *Index) openQuery(ctx context.Context, prepared *preparedQuery) error {
	prepared.ctx = ctx
	work, closeWork, err := openWorkMeter(ctx, ix.settings.SearchWorkCap)
	if err != nil {
		return err
	}
	prepared.work, prepared.closeWork = work, closeWork
	if err := ix.openReads(prepared, groupFieldsOf(&prepared.params)); err != nil {
		prepared.close()
		return err
	}
	return nil
}

func (ix *Index) requireUsableVectorClause(request *model.QueryParams, modes searchModes) error {
	if err := ix.requireVectorSearchable(request, modes.vectorOnly || modes.hybrid); err != nil {
		return err
	}
	if !modes.hasVector {
		return nil
	}
	return requireUsableQueryVector(request)
}

func (ix *Index) validQueryParams(params *model.QueryParams) error {
	if err := requireValidTypoTolerance(params); err != nil {
		return err
	}
	if err := requireSortableFields(params.Sort, ix.settings.Schema, ix.settings.Strict); err != nil {
		return err
	}
	if err := ix.validateFilter(params.Filters); err != nil {
		return err
	}
	return ix.requireUsableQueryFields(params)
}

func (ix *Index) requireUsablePhrases(term analysedTerm, phraseReady func() error) error {
	if !term.quoted || term.quotes.keptPhraseCount == 0 {
		return nil
	}
	if err := requirePhrasesWithinLimits(term.quotes, ix.settings.TrackPositions); err != nil {
		return err
	}
	if phraseReady == nil {
		return nil
	}
	return phraseReady()
}

type QueryOptions struct {
	Binding     func() string
	PhraseReady func() error
}

func (ix *Index) Query(request model.QueryParams) (model.QueryResult, error) {
	return ix.QueryWith(context.Background(), request, QueryOptions{})
}

func (ix *Index) QueryContext(ctx context.Context, request model.QueryParams) (model.QueryResult, error) {
	return ix.QueryWith(ctx, request, QueryOptions{})
}

func (ix *Index) QueryWith(ctx context.Context, request model.QueryParams, options QueryOptions) (model.QueryResult, error) {
	started := time.Now()
	if err := ctx.Err(); err != nil {
		return model.QueryResult{}, err
	}
	prepared, err := ix.prepareQuery(request)
	if err != nil {
		return model.QueryResult{}, err
	}
	prepared.phraseReady = options.PhraseReady
	if options.Binding != nil {
		prepared.binding = options.Binding
	}
	pass, err := ix.settings.Analyzer.Prepare()
	if err != nil {
		return model.QueryResult{}, err
	}
	prepared.ctx = ctx
	if err := ix.analyseQueryTerm(prepared, pass); err != nil {
		return model.QueryResult{}, err
	}
	pinned, unpin, err := ix.Pin(ctx)
	if err != nil {
		return model.QueryResult{}, err
	}
	defer unpin()
	if err := ix.openQuery(pinned, prepared); err != nil {
		return model.QueryResult{}, err
	}
	defer prepared.close()
	found, err := ix.rankedResults(prepared, pass)
	if err != nil {
		return model.QueryResult{}, stoppedSearchFailure(ctx, err)
	}
	if err := ctx.Err(); err != nil {
		return model.QueryResult{}, err
	}
	shaped, err := ix.shapeResults(prepared, found)
	if err != nil {
		return model.QueryResult{}, err
	}
	if err := ix.applyHighlights(shaped.result.Hits, shaped.documents, prepared, pass); err != nil {
		return model.QueryResult{}, err
	}
	shaped.result.Elapsed = time.Since(started)
	shaped.result.Coverage = model.QueryCoverage{TotalPartitions: len(ix.partitions), QueriedPartitions: len(ix.partitions)}
	return shaped.result, nil
}

func (ix *Index) analyseQueryTerm(prepared *preparedQuery, pass *analysis.Pass) error {
	if isBlank(prepared.params.Term) || prepared.vectorOnly && prepared.params.Highlight == nil {
		return nil
	}
	analysed, err := analyseTerm(prepared.params.Term, prepared.params.Prefix, pass)
	if err != nil {
		return err
	}
	if !prepared.vectorOnly {
		if err := ix.requireUsablePhrases(analysed, prepared.phraseReady); err != nil {
			return err
		}
	}
	prepared.term = &analysed
	return nil
}

func (ix *Index) rankedResults(prepared *preparedQuery, pass *analysis.Pass) (fanOutResult, error) {
	if !prepared.vectorOnly && !prepared.hybrid {
		return ix.textRanked(prepared, pass)
	}
	cursorDepth, err := ix.cursorDepthOf(prepared)
	if err != nil {
		return fanOutResult{}, err
	}
	if prepared.vectorOnly {
		return ix.vectorRanked(prepared, cursorDepth)
	}
	return ix.hybridRanked(prepared, pass, cursorDepth)
}

func (ix *Index) textRanked(prepared *preparedQuery, pass *analysis.Pass) (fanOutResult, error) {
	plan, err := ix.planSearch(prepared, pass, prepared.term)
	if err != nil {
		return fanOutResult{}, err
	}
	return ix.fanOut(prepared, plan)
}
