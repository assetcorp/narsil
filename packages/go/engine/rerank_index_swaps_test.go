package engine_test

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	swappingRerankAdapter     = "swapping"
	rerankCallsThatSwap       = 4
	rerankCallsAcrossTheSwaps = rerankCallsThatSwap + 1
	fewerSwappedPartitions    = 1
	moreSwappedPartitions     = 2
)

var alternatingStopWords = []string{"meadow", "canyon"}

func registerSwappingReranker(t *testing.T, narsil *engine.Narsil, swap func(call int32) error) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	reranker := &callbackReranker{rerank: func(_ string, documents []string) ([]float64, error) {
		if call := calls.Add(1); call <= rerankCallsThatSwap {
			if err := swap(call); err != nil {
				return nil, err
			}
		}
		scores := make([]float64, len(documents))
		for at, text := range documents {
			scores[at] = titleLengthScore(text)
		}
		return scores, nil
	}}
	if err := narsil.RegisterRerankAdapter(swappingRerankAdapter, reranker); err != nil {
		t.Fatalf("registering the swapping reranker failed: %v", err)
	}
	return &calls
}

func swappedTrailSearch() engine.QueryParams {
	params := rerankedTrailSearch()
	params.Rerank.Adapter = swappingRerankAdapter
	return params
}

func requireSwappedTrailPage(t *testing.T, target *engine.Narsil, calls *atomic.Int32) {
	t.Helper()
	result, err := finishedWithin(t, "the reranked query", func() (engine.QueryResult, error) {
		return target.Query(context.Background(), trailIndex, swappedTrailSearch())
	})
	if err != nil {
		t.Fatalf("the reranked query failed with %s: %v", codeOrMessage(err), err)
	}
	requireTrailPage(t, result, restoredTrails)
	if got := calls.Load(); got != rerankCallsAcrossTheSwaps {
		t.Fatalf("the reranker ran %d times, expected %d", got, rerankCallsAcrossTheSwaps)
	}
}

func trailPartitions(narsil *engine.Narsil) int {
	for _, info := range narsil.ListIndexes() {
		if info.Name == trailIndex {
			return info.PartitionCount
		}
	}
	return 0
}

func rebalanceToTheOtherCount(narsil *engine.Narsil) error {
	before := trailPartitions(narsil)
	wanted := moreSwappedPartitions
	if before == moreSwappedPartitions {
		wanted = fewerSwappedPartitions
	}
	if err := narsil.Rebalance(context.Background(), trailIndex, wanted); err != nil {
		return err
	}
	if after := trailPartitions(narsil); after != wanted {
		return fmt.Errorf("the rebalance left %d partitions, expected %d", after, wanted)
	}
	return nil
}

func TestARerankedQueryReturnsItsPageWhenARebalanceSwapsTheIndexDuringEachOfFourRerankCalls(t *testing.T) {
	target := startedForCallbacks(t, false)
	config := trailConfig("")
	config.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(moreSwappedPartitions)}
	fillTrails(t, target, config, restoredTrails)
	calls := registerSwappingReranker(t, target, func(int32) error {
		return rebalanceToTheOtherCount(target)
	})
	requireSwappedTrailPage(t, target, calls)
}

func TestARerankedQueryReturnsItsPageWhenAnAnalysisChangeSwapsTheIndexDuringEachOfFourRerankCalls(t *testing.T) {
	target := startedForCallbacks(t, false)
	fillTrails(t, target, trailConfig(""), restoredTrails)
	calls := registerSwappingReranker(t, target, func(call int32) error {
		words := alternatingStopWords[int(call)%len(alternatingStopWords)]
		return target.ChangeAnalysis(context.Background(), trailIndex,
			engine.AnalysisChange{StopWords: engine.ChangeToStopWordList(words)})
	})
	requireSwappedTrailPage(t, target, calls)
}
