package engine

import (
	"context"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type stagedRerank struct {
	target   *index.Index
	pinned   context.Context
	unpin    func()
	stage    *index.RerankStage
	answered bool
	result   model.QueryResult
}

func (staged *stagedRerank) release() {
	staged.unpin()
}

func (staged *stagedRerank) finish(entry *indexEntry, scores []float64, requested model.DocumentProjection) (model.QueryResult, error) {
	result, err := staged.stage.Finish(scores)
	if err != nil {
		return model.QueryResult{}, err
	}
	if err := entry.attachHitVectors(staged.pinned, &result, requested); err != nil {
		return model.QueryResult{}, err
	}
	return result, nil
}

func (n *Narsil) stageRerank(ctx context.Context, entry *indexEntry, target *index.Index, resolved model.QueryParams,
	options index.QueryOptions) (*stagedRerank, error) {
	pinned, unpin, err := target.Pin(ctx)
	if err != nil {
		return nil, err
	}
	stage, err := target.StageReranked(pinned, resolved, n.rerank.maxWindow, options)
	if err != nil {
		unpin()
		return nil, err
	}
	staged := &stagedRerank{target: target, pinned: pinned, unpin: unpin, stage: stage}
	if stage.AwaitsScores() {
		return staged, nil
	}
	if _, err := stage.Score(pinned, n.rerankScorer); err != nil {
		unpin()
		return nil, err
	}
	if staged.result, err = staged.finish(entry, nil, resolved.Document); err != nil {
		unpin()
		return nil, err
	}
	staged.answered = true
	return staged, nil
}

func (n *Narsil) scoreWithoutHoldingEntry(entry *indexEntry, staged *stagedRerank) ([]float64, error) {
	entry.maintenance.Add(1)
	entry.useMu.RUnlock()
	defer func() {
		entry.useMu.RLock()
		entry.maintenance.Add(-1)
	}()
	return staged.stage.Score(staged.pinned, n.rerankScorer)
}

func (n *Narsil) queryReranked(ctx context.Context, entry *indexEntry, resolved model.QueryParams,
	options index.QueryOptions) (model.QueryResult, bool, error) {
	staged, stale, err := readUnderOneAnalysisDiscarding(ctx, n, entry, func(target *index.Index) (*stagedRerank, error) {
		return n.stageRerank(ctx, entry, target, resolved, options)
	}, (*stagedRerank).release)
	if err != nil {
		return model.QueryResult{}, false, err
	}
	defer staged.release()
	if staged.answered {
		staged.result.AnalysisStale = stale
		return staged.result, true, nil
	}
	scores, scoreErr := n.scoreWithoutHoldingEntry(entry, staged)
	if entry.retired || entry.index() != staged.target || entry.analysisIsStale() != stale {
		return model.QueryResult{}, false, ctx.Err()
	}
	if scoreErr != nil {
		return model.QueryResult{}, false, scoreErr
	}
	var result model.QueryResult
	err = n.workers.run(ctx, entry, func() error {
		var finishErr error
		result, finishErr = staged.finish(entry, scores, resolved.Document)
		return finishErr
	})
	if err != nil {
		return model.QueryResult{}, false, queryTokensRefused(err)
	}
	result.AnalysisStale = stale
	return result, true, nil
}

func indexReplacedDuringReranks(indexName string, reranks int) error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		fmt.Sprintf("Changes to index %q replaced it during each of %d calls to its rerank adapter", indexName, reranks),
		map[string]any{"indexName": indexName, "reranks": reranks})
}

func (n *Narsil) answerQuery(ctx context.Context, indexName string, entry *indexEntry, release func(),
	params model.QueryParams, options index.QueryOptions) (model.QueryResult, model.QueryParams, func(), error) {
	var earlier *queryEmbedding
	replacedReranks := 0
	for {
		held, releaseHeld, embedded, err := n.embedForQuery(ctx, indexName, entry, release, params, earlier)
		if err != nil {
			return model.QueryResult{}, params, nil, err
		}
		if embedded.params.Rerank == nil {
			result, stale, err := readUnderOneAnalysis(ctx, n, held, func(target *index.Index) (model.QueryResult, error) {
				return n.queryPinned(ctx, held, target, embedded.params, options)
			})
			if err != nil {
				releaseHeld()
				return model.QueryResult{}, params, nil, err
			}
			result.AnalysisStale = stale
			return result, embedded.params, releaseHeld, nil
		}
		result, answered, err := n.queryReranked(ctx, held, embedded.params, options)
		if err != nil {
			releaseHeld()
			return model.QueryResult{}, params, nil, err
		}
		if answered {
			return result, embedded.params, releaseHeld, nil
		}
		releaseHeld()
		if replacedReranks++; replacedReranks >= maxQueryReranks {
			return model.QueryResult{}, params, nil, indexReplacedDuringReranks(indexName, replacedReranks)
		}
		earlier = &embedded
		if entry, release, err = n.acquire(indexName); err != nil {
			return model.QueryResult{}, params, nil, err
		}
	}
}
