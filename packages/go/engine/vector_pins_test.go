package engine_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	pinnedIndexName         = "harbour"
	pinnedDimension         = 12
	pinnedDocuments         = 96
	pinnedPromotion         = 16
	pinnedNearest           = 10
	pinnedAdapterName       = "held"
	pinnedRerankTimeout     = 10 * time.Minute
	pinnedSeed              = 4_242
	pinnedChangedPerKind    = 4
	pinnedReplacementOffset = 0.5
	pinnedFailingQuery      = "fail"
	pinnedPanickingQuery    = "panic"
	pinnedPlainQuery        = "harbour"
)

type heldReranker struct {
	entered chan struct{}
	release chan struct{}
}

func newHeldReranker(capacity int) *heldReranker {
	return &heldReranker{entered: make(chan struct{}, capacity), release: make(chan struct{})}
}

func (r *heldReranker) Rerank(ctx context.Context, query string, documents []string) ([]float64, error) {
	r.entered <- struct{}{}
	select {
	case <-r.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	switch query {
	case pinnedFailingQuery:
		return nil, errors.New("the reranker refused the documents")
	case pinnedPanickingQuery:
		panic("the reranker crashed")
	}
	scores := make([]float64, len(documents))
	for position := range scores {
		scores[position] = float64(len(documents) - position)
	}
	return scores, nil
}

type pinnedHarbour struct {
	ctx      context.Context
	narsil   *engine.Narsil
	reranker *heldReranker
	random   *rand.Rand
	vectors  map[string][]float32
}

func openPinnedHarbour(t *testing.T, heldCapacity int, plugins ...engine.Plugin) *pinnedHarbour {
	t.Helper()
	ctx := context.Background()
	reranker := newHeldReranker(heldCapacity)
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		RerankAdapters: map[string]engine.RerankAdapter{pinnedAdapterName: reranker},
		RerankTimeout:  engine.Some(pinnedRerankTimeout), Plugins: plugins})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	schema := engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(pinnedDimension)}
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(pinnedPromotion)}
	if err := narsil.CreateIndex(ctx, pinnedIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	harbour := &pinnedHarbour{ctx: ctx, narsil: narsil, reranker: reranker, random: rand.New(rand.NewSource(pinnedSeed)),
		vectors: map[string][]float32{}}
	batch := make([]engine.Document, 0, pinnedDocuments)
	for position := range pinnedDocuments {
		id := "berth-" + strconv.Itoa(position)
		vector := harbour.randomVector()
		harbour.vectors[id] = vector
		batch = append(batch, engine.Document{"id": id, "title": "berth " + id, "embedding": vector})
	}
	if result, err := narsil.InsertBatch(ctx, pinnedIndexName, batch, engine.InsertOptions{}); err != nil || len(result.Failed) > 0 {
		t.Fatalf("loading the harbour failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, pinnedIndexName, "embedding"); err != nil {
		t.Fatalf("building the graph failed: %v", err)
	}
	return harbour
}

func (h *pinnedHarbour) randomVector() []float32 {
	vector := make([]float32, pinnedDimension)
	for component := range vector {
		vector[component] = float32(h.random.Float64()*2 - 1)
	}
	return vector
}

func (h *pinnedHarbour) snapshot() map[string][]float32 {
	copied := make(map[string][]float32, len(h.vectors))
	for id, vector := range h.vectors {
		copied[id] = vector
	}
	return copied
}

func pinnedQuery(query []float32, rerankQuery string) engine.QueryParams {
	params := placingQuery(query, true)
	params.Limit = engine.Some(pinnedNearest)
	params.Document = engine.IncludeFields("title", "embedding")
	if rerankQuery != "" {
		params.Rerank = &engine.RerankConfig{Adapter: pinnedAdapterName, Fields: []string{"title"},
			Query: engine.Some(rerankQuery)}
	}
	return params
}

type heldQuery struct {
	result engine.QueryResult
	err    error
	done   chan struct{}
}

func (h *pinnedHarbour) holdQuery(ctx context.Context, query []float32, rerankQuery string) *heldQuery {
	held := &heldQuery{done: make(chan struct{})}
	go func() {
		defer close(held.done)
		held.result, held.err = h.narsil.Query(ctx, pinnedIndexName, pinnedQuery(query, rerankQuery))
	}()
	<-h.reranker.entered
	return held
}

func (h *pinnedHarbour) update(t *testing.T, id string, vector []float32) {
	t.Helper()
	if err := h.narsil.Update(h.ctx, pinnedIndexName, id, engine.Document{"title": "berth " + id, "embedding": vector},
		engine.WriteOptions{}); err != nil {
		t.Fatalf("updating %s failed: %v", id, err)
	}
	h.vectors[id] = vector
}

func (h *pinnedHarbour) remove(t *testing.T, id string) {
	t.Helper()
	if err := h.narsil.Remove(h.ctx, pinnedIndexName, id, engine.WriteOptions{}); err != nil {
		t.Fatalf("removing %s failed: %v", id, err)
	}
	delete(h.vectors, id)
}

func (h *pinnedHarbour) insert(t *testing.T, id string, vector []float32) {
	t.Helper()
	if _, err := h.narsil.Insert(h.ctx, pinnedIndexName, engine.Document{"title": "berth " + id, "embedding": vector}, id,
		engine.InsertOptions{}); err != nil {
		t.Fatalf("inserting %s failed: %v", id, err)
	}
	h.vectors[id] = vector
}

func (h *pinnedHarbour) compact(t *testing.T) {
	t.Helper()
	if err := h.narsil.CompactVectors(h.ctx, pinnedIndexName, "embedding"); err != nil {
		t.Fatalf("compacting the vectors failed: %v", err)
	}
}

func (h *pinnedHarbour) retiredShare(t *testing.T) float64 {
	t.Helper()
	statuses, err := h.narsil.VectorMaintenanceStatus(pinnedIndexName)
	if err != nil || len(statuses) != 1 {
		t.Fatalf("reading the maintenance status failed: %v %+v", err, statuses)
	}
	return statuses[0].TombstoneRatio
}

func nearestIDs(query []float32, vectors map[string][]float32) []string {
	neighbours := bruteForceNearest(query, vectors)
	ids := make([]string, len(neighbours))
	for position, neighbour := range neighbours {
		ids[position] = neighbour.id
	}
	return ids
}

func nudged(vector []float32, offset float32) []float32 {
	moved := append([]float32(nil), vector...)
	for component := range moved {
		moved[component] += offset
	}
	return moved
}

func requireHitsFromState(label string, hits []engine.Hit, state map[string][]float32, nearest []string) error {
	if len(hits) != len(nearest) {
		return fmt.Errorf("%s returned %d hits, while the state it started from holds %d nearest", label, len(hits), len(nearest))
	}
	for position, hit := range hits {
		if hit.ID != nearest[position] {
			return fmt.Errorf("%s returned %s at %d, while the state it started from ranks %s there", label, hit.ID, position,
				nearest[position])
		}
		vector, carried := returnedEmbedding(hit.Document)
		if carried && !sameVector(vector, state[hit.ID]) {
			return fmt.Errorf("%s returned %s with a vector that a later write gave it", label, hit.ID)
		}
	}
	return nil
}

func requireScoresMatchVectors(label string, query []float32, hits []engine.Hit, state map[string][]float32) error {
	return checkHitsMatchTheirVectors(label, query, hits, func(id string, vector []float32) bool {
		held, live := state[id]
		return live && sameVector(held, vector)
	})
}

func TestAHeldVectorSearchAnswersFromTheStateItStartedFrom(t *testing.T) {
	harbour := openPinnedHarbour(t, 1)
	query := harbour.randomVector()
	before := harbour.snapshot()
	nearest := nearestIDs(query, before)
	held := harbour.holdQuery(harbour.ctx, query, pinnedPlainQuery)
	harbour.remove(t, nearest[0])
	harbour.update(t, nearest[1], nudged(before[nearest[1]], pinnedReplacementOffset))
	harbour.insert(t, "berth-arrived", query)
	harbour.compact(t)
	if err := harbour.narsil.OptimizeVectors(harbour.ctx, pinnedIndexName, "embedding"); err != nil {
		t.Fatalf("rebuilding the graph during the search failed: %v", err)
	}
	close(harbour.reranker.release)
	<-held.done
	if held.err != nil {
		t.Fatalf("the held search failed: %s: %v", codeOrMessage(held.err), held.err)
	}
	if err := requireHitsFromState("the held search", held.result.Hits, before, nearest); err != nil {
		t.Fatal(err)
	}
	after, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, pinnedQuery(query, ""))
	if err != nil {
		t.Fatalf("the search after the writes failed: %v", err)
	}
	if err := requireScoresMatchVectors("the search after the writes", query, after.Hits, harbour.vectors); err != nil {
		t.Fatal(err)
	}
	if err := requireHitsFromState("the search after the writes", after.Hits, harbour.vectors,
		nearestIDs(query, harbour.vectors)); err != nil {
		t.Fatal(err)
	}
}

func TestAnAbandonedVectorSearchLeavesNoRetiredVectorHeld(t *testing.T) {
	endings := []struct {
		name        string
		rerankQuery string
		cancel      bool
	}{
		{name: "a cancelled context", rerankQuery: pinnedPlainQuery, cancel: true},
		{name: "a reranker error", rerankQuery: pinnedFailingQuery},
		{name: "a reranker panic", rerankQuery: pinnedPanickingQuery},
	}
	for _, ending := range endings {
		t.Run(ending.name, func(t *testing.T) {
			harbour := openPinnedHarbour(t, 1)
			ctx, cancel := context.WithCancel(harbour.ctx)
			defer cancel()
			query := harbour.randomVector()
			held := harbour.holdQuery(ctx, query, ending.rerankQuery)
			ids := make([]string, 0, len(harbour.vectors))
			for id := range harbour.vectors {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids[:pinnedChangedPerKind] {
				harbour.remove(t, id)
			}
			for _, id := range ids[pinnedChangedPerKind : 2*pinnedChangedPerKind] {
				harbour.update(t, id, harbour.randomVector())
			}
			harbour.compact(t)
			if share := harbour.retiredShare(t); share <= 0 {
				t.Fatalf("compaction freed the retired vectors that a running search holds, leaving a share of %v", share)
			}
			if ending.cancel {
				cancel()
			} else {
				close(harbour.reranker.release)
			}
			<-held.done
			if held.err == nil {
				t.Fatalf("the abandoned search returned %d hits without an error", len(held.result.Hits))
			}
			harbour.compact(t)
			if share := harbour.retiredShare(t); share != 0 {
				t.Fatalf("after %s, compaction still holds a retired share of %v", ending.name, share)
			}
		})
	}
}

func TestAReusedVectorPlaceNeverReachesAnOlderPinnedSearch(t *testing.T) {
	harbour := openPinnedHarbour(t, 1)
	query := harbour.randomVector()
	before := harbour.snapshot()
	nearest := nearestIDs(query, before)
	held := harbour.holdQuery(harbour.ctx, query, pinnedPlainQuery)
	for round, id := range nearest[:pinnedChangedPerKind] {
		harbour.remove(t, id)
		harbour.compact(t)
		harbour.insert(t, id, nudged(query, float32(round+1)*1e-3))
		harbour.insert(t, "berth-filler-"+strconv.Itoa(round), harbour.randomVector())
		harbour.update(t, id, nudged(query, float32(round+1)*2e-3))
		harbour.compact(t)
	}
	if err := harbour.narsil.OptimizeVectors(harbour.ctx, pinnedIndexName, "embedding"); err != nil {
		t.Fatalf("rebuilding the graph during the search failed: %v", err)
	}
	close(harbour.reranker.release)
	<-held.done
	if held.err != nil {
		t.Fatalf("the held search failed: %s: %v", codeOrMessage(held.err), held.err)
	}
	if err := requireHitsFromState("the held search", held.result.Hits, before, nearest); err != nil {
		t.Fatal(err)
	}
	harbour.compact(t)
	if share := harbour.retiredShare(t); share != 0 {
		t.Fatalf("after the held search ended, compaction still holds a retired share of %v", share)
	}
	after, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, pinnedQuery(query, ""))
	if err != nil {
		t.Fatalf("the search after the writes failed: %v", err)
	}
	if err := requireScoresMatchVectors("the search after the writes", query, after.Hits, harbour.vectors); err != nil {
		t.Fatal(err)
	}
	if err := requireHitsFromState("the search after the writes", after.Hits, harbour.vectors,
		nearestIDs(query, harbour.vectors)); err != nil {
		t.Fatal(err)
	}
}
