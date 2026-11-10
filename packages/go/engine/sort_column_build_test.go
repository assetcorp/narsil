package engine_test

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	shelfIndexName       = "shelf"
	shelfAdapterName     = "held-shelf"
	shelfDocuments       = 40
	shelfYearStride      = 7919
	shelfYearSpan        = 1000
	shelfSortedLimit     = 10
	shelfRerankTimeout   = 10 * time.Minute
	shelfSortedDeadline  = 30 * time.Second
	shelfSharedTitleWord = "volume"
)

func shelfYear(position int) float64 {
	return float64(position * shelfYearStride % shelfYearSpan)
}

func TestSortOnNewFieldFinishesWhileAnotherSearchIsHeld(t *testing.T) {
	ctx := context.Background()
	reranker := newHeldReranker(1)
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		RerankAdapters: map[string]engine.RerankAdapter{shelfAdapterName: reranker},
		RerankTimeout:  engine.Some(shelfRerankTimeout)})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	schema := engine.Schema{"title": engine.FieldString, "year": engine.FieldNumber}
	if err := narsil.CreateIndex(ctx, shelfIndexName, engine.IndexConfig{Schema: schema}); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	years := map[string]float64{}
	batch := make([]*engine.Document, 0, shelfDocuments)
	for position := range shelfDocuments {
		id := "volume-" + strconv.Itoa(position)
		years[id] = shelfYear(position)
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": id, "title": "volume " + id, "year": years[id]}))
	}
	if result, err := narsil.InsertBatch(ctx, shelfIndexName, batch, engine.InsertOptions{}); err != nil || len(result.Failed) > 0 {
		t.Fatalf("loading the shelf failed: %v %+v", err, result.Failed)
	}

	held := &heldQuery{done: make(chan struct{})}
	go func() {
		defer close(held.done)
		held.result, held.err = narsil.Query(ctx, shelfIndexName, engine.QueryParams{Term: shelfSharedTitleWord,
			Rerank: &engine.RerankConfig{Adapter: shelfAdapterName, Fields: []string{"title"}}})
	}()
	<-reranker.entered
	released := false
	release := func() {
		if !released {
			released = true
			close(reranker.release)
		}
	}
	t.Cleanup(release)

	lateID := "volume-" + strconv.Itoa(shelfDocuments)
	years[lateID] = shelfYear(shelfDocuments)
	if _, err := narsil.Insert(ctx, shelfIndexName, engine.DocumentFromMap(map[string]any{"title": "volume " + lateID, "year": years[lateID]}),
		lateID, engine.InsertOptions{}); err != nil {
		t.Fatalf("inserting %s while a search is held failed: %v", lateID, err)
	}

	sorted := &heldQuery{done: make(chan struct{})}
	go func() {
		defer close(sorted.done)
		sorted.result, sorted.err = narsil.Query(ctx, shelfIndexName, engine.QueryParams{Term: shelfSharedTitleWord,
			Sort:     []engine.SortField{{Field: "year", Direction: engine.SortAscending}},
			Limit:    engine.Some(shelfSortedLimit),
			Document: engine.NoDocumentFields()})
	}()
	select {
	case <-sorted.done:
	case <-held.done:
		t.Fatalf("the held search finished before the reranker released it: %v", held.err)
	case <-time.After(shelfSortedDeadline):
		release()
		t.Fatalf("the search that sorts on year waited %s behind the held search", shelfSortedDeadline)
	}
	select {
	case <-held.done:
		t.Fatalf("the held search finished before the reranker released it: %v", held.err)
	default:
	}
	if sorted.err != nil {
		t.Fatalf("the search that sorts on year failed: %v", sorted.err)
	}

	ids := make([]string, 0, len(years))
	for id := range years {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(left, right string) int { return cmp.Compare(years[left], years[right]) })
	want := ids[:shelfSortedLimit]
	if len(sorted.result.Hits) != len(want) {
		t.Fatalf("the sorted search returned %d hits, while %d were expected", len(sorted.result.Hits), len(want))
	}
	for position, hit := range sorted.result.Hits {
		if hit.ID != want[position] {
			t.Fatalf("hit %d of the sorted search is %s with year %v, while %s with year %v was expected", position, hit.ID,
				years[hit.ID], want[position], years[want[position]])
		}
	}

	release()
	<-held.done
	if held.err != nil {
		t.Fatalf("the held search failed once released: %v", held.err)
	}
}
