package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var errQueryAnalysisChanged = errors.New("the index changed during query analysis")

func (n *Narsil) analyseForSearch(ctx context.Context, name string, entry *indexEntry, release func(),
	params model.QueryParams, options index.QueryOptions) (*indexEntry, func(), index.QueryOptions, error) {
	target := entry.index()
	release()
	analysed, analysisErr := target.AnalyseQuery(params)
	held, releaseHeld, err := n.acquireContext(ctx, name)
	if err != nil {
		return nil, releasedNothing, options, err
	}
	if target != held.index() {
		return held, releaseHeld, options, errQueryAnalysisChanged
	}
	options.Analysed = analysed
	options.PhraseReady = held.phraseReady
	return held, releaseHeld, options, queryTokensRefused(analysisErr)
}

func analysisMatches(target *index.Index, options index.QueryOptions) error {
	if options.Analysed == nil || !options.Analysed.Matches(target) {
		return errQueryAnalysisChanged
	}
	return nil
}

func indexReplacedDuringAnalysis(name string, changes int) error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		fmt.Sprintf("Changes to index %q replaced it during each of %d query analyses", name, changes),
		map[string]any{"indexName": name, "analyses": changes})
}

func (n *Narsil) preflightAnalysed(ctx context.Context, name string, entry *indexEntry, release func(),
	params model.QueryParams) (model.PreflightResult, error) {
	defer func() { release() }()
	var earlier *queryEmbedding
	changes := 0
	for {
		var embedded queryEmbedding
		var err error
		entry, release, embedded, err = n.embedForQuery(ctx, name, entry, release, params, earlier)
		if err != nil {
			release = releasedNothing
			return model.PreflightResult{}, err
		}
		var options index.QueryOptions
		entry, release, options, err = n.analyseForSearch(ctx, name, entry, release, embedded.params, options)
		if errors.Is(err, errQueryAnalysisChanged) {
			changes++
			if changes >= maxCallsAcrossIndexChanges {
				return model.PreflightResult{}, indexReplacedDuringAnalysis(name, changes)
			}
			earlier = &embedded
			continue
		}
		if err != nil {
			return model.PreflightResult{}, err
		}
		result, stale, err := readUnderOneAnalysis(ctx, n, entry, func(target *index.Index) (model.PreflightResult, error) {
			if err := analysisMatches(target, options); err != nil {
				return model.PreflightResult{}, err
			}
			return target.PreflightWith(ctx, embedded.params, options)
		})
		if errors.Is(err, errQueryAnalysisChanged) {
			earlier = &embedded
			continue
		}
		result.AnalysisStale = stale
		return result, err
	}
}
