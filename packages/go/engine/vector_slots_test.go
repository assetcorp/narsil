package engine_test

import (
	"context"
	"runtime"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	searchThreadSlotLimit = 65_536
	heldSearchWave        = 4_096
)

func lightVectorQuery(query []float32) engine.QueryParams {
	return engine.QueryParams{Mode: engine.SearchVector, Limit: engine.Some(1), Document: engine.NoDocumentFields(),
		Vector: &engine.VectorQueryConfig{Field: "embedding", Value: query}}
}

func heldRerankQuery(query []float32) engine.QueryParams {
	params := lightVectorQuery(query)
	params.Rerank = &engine.RerankConfig{Adapter: pinnedAdapterName, Fields: []string{"title"},
		Query: engine.Some(pinnedPlainQuery)}
	return params
}

func holdEverySearchSlot(harbour *pinnedHarbour, query []float32) (*sync.WaitGroup, []error) {
	harbour.reranker.release = make(chan struct{})
	failures := make([]error, searchThreadSlotLimit)
	var running sync.WaitGroup
	for start := 0; start < searchThreadSlotLimit; start += heldSearchWave {
		wave := min(heldSearchWave, searchThreadSlotLimit-start)
		for position := start; position < start+wave; position++ {
			running.Add(1)
			go func() {
				defer running.Done()
				_, failures[position] = harbour.narsil.Query(harbour.ctx, pinnedIndexName, heldRerankQuery(query))
			}()
		}
		for range wave {
			<-harbour.reranker.entered
		}
		runtime.GC()
	}
	return &running, failures
}

func requireSlotRefused(t *testing.T, harbour *pinnedHarbour, query []float32) {
	t.Helper()
	for _, params := range []engine.QueryParams{lightVectorQuery(query), {Term: "berth"}} {
		_, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, params)
		if code := codeOrMessage(err); code != engine.CodeWorkerBusy {
			t.Fatalf("a search past %d in flight got %q, while the limit calls for %s", searchThreadSlotLimit, code,
				engine.CodeWorkerBusy)
		}
	}
}

func requireEverySearchSucceeded(t *testing.T, running *sync.WaitGroup, failures []error) {
	t.Helper()
	running.Wait()
	for position, err := range failures {
		if err != nil {
			t.Fatalf("held search %d failed: %s: %v", position, codeOrMessage(err), err)
		}
	}
}

func TestSearchesPastTheThreadSlotLimitGetWorkerBusyAndEverySlotComesBack(t *testing.T) {
	harbour := openPinnedHarbour(t, searchThreadSlotLimit)
	query := harbour.randomVector()
	for round := range 2 {
		running, failures := holdEverySearchSlot(harbour, query)
		requireSlotRefused(t, harbour, query)
		close(harbour.reranker.release)
		requireEverySearchSucceeded(t, running, failures)
		result, err := harbour.narsil.Query(context.Background(), pinnedIndexName, pinnedQuery(query, ""))
		if err != nil {
			t.Fatalf("a search after round %d released every slot failed: %s: %v", round, codeOrMessage(err), err)
		}
		if err := requireScoresMatchVectors("a search after the slots came back", query, result.Hits, harbour.vectors); err != nil {
			t.Fatal(err)
		}
		keyword, err := harbour.narsil.Query(context.Background(), pinnedIndexName, engine.QueryParams{Term: "berth"})
		if err != nil || len(keyword.Hits) == 0 {
			t.Fatalf("a keyword search after round %d released every slot failed or found nothing: %v", round, err)
		}
	}
}
