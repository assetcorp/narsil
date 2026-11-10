package engine_test

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	searchThreadSlotLimit = 65_536
	heldSearchWave        = 4_096
)

type finishedSearchGate struct {
	holding atomic.Bool
	entered chan struct{}
	release chan struct{}
}

func (gate *finishedSearchGate) afterSearch(ctx context.Context, search *engine.SearchContext) error {
	if search.Params == nil || search.Params.Vector == nil || !gate.holding.Load() {
		return nil
	}
	gate.entered <- struct{}{}
	select {
	case <-gate.release:
	case <-ctx.Done():
	}
	return nil
}

func lightVectorQuery(query []float32) engine.QueryParams {
	return engine.QueryParams{Mode: engine.SearchVector, Limit: engine.Some(1), Document: engine.NoDocumentFields(),
		Vector: &engine.VectorQueryConfig{Field: "embedding", Value: query}}
}

func holdEverySearchSlot(harbour *pinnedHarbour, gate *finishedSearchGate, query []float32) (*sync.WaitGroup, []error) {
	gate.release = make(chan struct{})
	gate.holding.Store(true)
	failures := make([]error, searchThreadSlotLimit)
	var running sync.WaitGroup
	for start := 0; start < searchThreadSlotLimit; start += heldSearchWave {
		wave := min(heldSearchWave, searchThreadSlotLimit-start)
		for position := start; position < start+wave; position++ {
			running.Add(1)
			go func() {
				defer running.Done()
				_, failures[position] = harbour.narsil.Query(harbour.ctx, pinnedIndexName, lightVectorQuery(query))
			}()
		}
		for range wave {
			<-gate.entered
		}
		runtime.GC()
	}
	gate.holding.Store(false)
	return &running, failures
}

func requireSlotRefused(t *testing.T, harbour *pinnedHarbour, query []float32) {
	t.Helper()
	_, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, lightVectorQuery(query))
	if code := codeOrMessage(err); code != engine.CodeWorkerBusy {
		t.Fatalf("a search past %d in flight got %q, while the limit calls for %s", searchThreadSlotLimit, code,
			engine.CodeWorkerBusy)
	}
	keyword, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, engine.QueryParams{Term: "berth"})
	if err != nil || len(keyword.Hits) == 0 {
		t.Fatalf("a keyword search while every vector slot is taken failed or found nothing: %v", err)
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
	gate := &finishedSearchGate{entered: make(chan struct{}, searchThreadSlotLimit)}
	harbour := openPinnedHarbour(t, 1, engine.Plugin{Name: "finished-search-gate", AfterSearch: gate.afterSearch})
	query := harbour.randomVector()
	for round := range 2 {
		running, failures := holdEverySearchSlot(harbour, gate, query)
		requireSlotRefused(t, harbour, query)
		close(gate.release)
		requireEverySearchSucceeded(t, running, failures)
		result, err := harbour.narsil.Query(context.Background(), pinnedIndexName, pinnedQuery(query, ""))
		if err != nil {
			t.Fatalf("a search after round %d released every slot failed: %s: %v", round, codeOrMessage(err), err)
		}
		if err := requireScoresMatchVectors("a search after the slots came back", query, result.Hits, harbour.vectors); err != nil {
			t.Fatal(err)
		}
	}
}
