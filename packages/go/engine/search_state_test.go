package engine_test

import (
	"context"
	"fmt"
	"math/rand"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	waveIndexName      = "tides"
	waveDimension      = 8
	waveCount          = 12
	waveDocuments      = 60
	wavePartitions     = 2
	waveSearchers      = 4
	wavePromotion      = 64
	waveSeed           = 5_151
	waveSearchLimit    = 2 * waveCount * waveDocuments
	waveSearchKinds    = 4
	waveMarker         = "tide"
	heldHybridInserted = "berth-arrived"
)

func waveLabel(wave int) string {
	return "wave" + strconv.Itoa(wave)
}

func openWaveIndex(t *testing.T) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	config := engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString, "wave": engine.FieldEnum,
			"near": engine.VectorFieldType(waveDimension), "far": engine.VectorFieldType(waveDimension)},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(wavePromotion)},
		Partitions:      engine.PartitionConfig{MaxPartitions: engine.Some(wavePartitions)},
	}
	if err := narsil.CreateIndex(ctx, waveIndexName, config); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	if err := narsil.Rebalance(ctx, waveIndexName, wavePartitions); err != nil {
		t.Fatalf("spreading the index over %d partitions failed: %v", wavePartitions, err)
	}
	return narsil
}

func waveVector(random *rand.Rand) []float32 {
	vector := make([]float32, waveDimension)
	for component := range vector {
		vector[component] = float32(random.Float64()*2 - 1)
	}
	vector[random.Intn(waveDimension)] += 2
	return vector
}

func insertWave(ctx context.Context, narsil *engine.Narsil, random *rand.Rand, wave int) error {
	batch := make([]*engine.Document, 0, waveDocuments)
	for position := range waveDocuments {
		id := waveLabel(wave) + "-" + strconv.Itoa(position)
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": id, "title": waveMarker + " " + id,
			"wave": waveLabel(wave), "near": waveVector(random), "far": waveVector(random)}))
	}
	result, err := narsil.InsertBatch(ctx, waveIndexName, batch, engine.InsertOptions{})
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return nil
}

func waveSearch(kind int, random *rand.Rand) (string, engine.QueryParams) {
	params := engine.QueryParams{Limit: engine.Some(waveSearchLimit), Document: engine.IncludeFields("wave"),
		Facets: engine.FacetConfig{"wave": {}}}
	exact := func(field string) *engine.VectorQueryConfig {
		return &engine.VectorQueryConfig{Field: field, Value: waveVector(random),
			EfSearch: engine.Some(placingExactEfSearch), Oversample: engine.Some(placingExactOversample)}
	}
	switch kind {
	case 0:
		params.Term = waveMarker
		return "a keyword search", params
	case 1:
		params.Mode, params.Vector, params.Facets = engine.SearchVector, exact("near"), nil
		return "a vector search on the first field", params
	case 2:
		params.Mode, params.Vector, params.Facets = engine.SearchVector, exact("far"), nil
		return "a vector search on the second field", params
	}
	params.Mode, params.Term, params.Vector = engine.SearchHybrid, waveMarker, exact("far")
	params.Hybrid = &engine.HybridConfig{Depth: engine.Some(waveSearchLimit)}
	return "a hybrid search", params
}

func requireWholeWaves(label string, result engine.QueryResult, written int64) error {
	perWave := map[string]int{}
	for _, hit := range result.Hits {
		wave, held := hit.Document.Get("wave")
		name, isText := wave.(string)
		if !held || !isText {
			return fmt.Errorf("%s returned %s without its wave", label, hit.ID)
		}
		perWave[name]++
	}
	for wave := 1; wave <= len(perWave); wave++ {
		if count := perWave[waveLabel(wave)]; count != waveDocuments {
			return fmt.Errorf("%s saw %d of the %d documents of %s, among %d waves and %d hits", label, count, waveDocuments,
				waveLabel(wave), len(perWave), len(result.Hits))
		}
	}
	if int64(len(perWave)) < written {
		return fmt.Errorf("%s saw %d waves, while %d were acknowledged before it started", label, len(perWave), written)
	}
	if result.CountExact && result.Count != len(result.Hits) {
		return fmt.Errorf("%s counts %d matches and returns %d hits within a limit above both", label, result.Count, len(result.Hits))
	}
	facet, faceted := result.Facets["wave"]
	if !faceted {
		return nil
	}
	if len(facet.Values) != len(perWave) {
		return fmt.Errorf("%s returns hits of %d waves and facet counts for %d", label, len(perWave), len(facet.Values))
	}
	for _, value := range facet.Values {
		if value.Count != perWave[value.Value] {
			return fmt.Errorf("%s counts %d documents in the facet of %s and returns %d of them", label, value.Count, value.Value,
				perWave[value.Value])
		}
	}
	return nil
}

func TestASearchSeesEachBatchWholeAcrossPartitionsAndVectorFields(t *testing.T) {
	narsil := openWaveIndex(t)
	ctx := context.Background()
	var written atomic.Int64
	var failure atomic.Pointer[error]
	fail := func(err error) {
		if err != nil {
			failure.CompareAndSwap(nil, &err)
		}
	}
	stop := make(chan struct{})
	var searchers sync.WaitGroup
	var searches atomic.Int64
	for searcher := range waveSearchers {
		searchers.Add(1)
		go func(searcher int) {
			defer searchers.Done()
			random := rand.New(rand.NewSource(int64(waveSeed + searcher)))
			for round := searcher; failure.Load() == nil; round++ {
				select {
				case <-stop:
					return
				default:
				}
				label, params := waveSearch(round%waveSearchKinds, random)
				acknowledged := written.Load()
				result, err := narsil.Query(ctx, waveIndexName, params)
				if err != nil {
					fail(fmt.Errorf("%s failed with %s: %w", label, codeOrMessage(err), err))
					return
				}
				fail(requireWholeWaves(label, result, acknowledged))
				searches.Add(1)
			}
		}(searcher)
	}
	random := rand.New(rand.NewSource(waveSeed))
	for wave := 1; wave <= waveCount && failure.Load() == nil; wave++ {
		fail(insertWave(ctx, narsil, random, wave))
		written.Store(int64(wave))
	}
	close(stop)
	searchers.Wait()
	if held := failure.Load(); held != nil {
		t.Fatal(*held)
	}
	if searches.Load() == 0 {
		t.Fatal("no search finished while the batches were written")
	}
	stats, err := narsil.GetStats(waveIndexName)
	if err != nil || stats.PartitionCount != wavePartitions {
		t.Fatalf("the index holds %d partitions (%v), so no batch crossed two of them", stats.PartitionCount, err)
	}
	for kind := range waveSearchKinds {
		label, params := waveSearch(kind, random)
		result, err := narsil.Query(ctx, waveIndexName, params)
		if err != nil {
			t.Fatalf("%s after the writes failed: %v", label, err)
		}
		if err := requireWholeWaves(label+" after the writes", result, waveCount); err != nil {
			t.Fatal(err)
		}
	}
}

func heldHybridQuery(query []float32, rerankQuery string) engine.QueryParams {
	params := pinnedQuery(query, rerankQuery)
	params.Mode, params.Term = engine.SearchHybrid, "berth"
	params.Hybrid = &engine.HybridConfig{Depth: engine.Some(2 * pinnedDocuments)}
	return params
}

func TestAHeldHybridSearchAnswersFromTheStateItStartedFrom(t *testing.T) {
	harbour := openPinnedHarbour(t, 1)
	query := harbour.randomVector()
	before := harbour.snapshot()
	first, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, heldHybridQuery(query, ""))
	if err != nil || len(first.Hits) != pinnedNearest {
		t.Fatalf("the hybrid search before the writes returned %d hits: %v", len(first.Hits), err)
	}
	expected := make([]string, len(first.Hits))
	for position, hit := range first.Hits {
		expected[position] = hit.ID
	}
	held := &heldQuery{done: make(chan struct{})}
	go func() {
		defer close(held.done)
		held.result, held.err = harbour.narsil.Query(harbour.ctx, pinnedIndexName, heldHybridQuery(query, pinnedPlainQuery))
	}()
	<-harbour.reranker.entered
	harbour.remove(t, expected[0])
	harbour.update(t, expected[1], nudged(before[expected[1]], pinnedReplacementOffset))
	harbour.insert(t, heldHybridInserted, query)
	harbour.compact(t)
	close(harbour.reranker.release)
	<-held.done
	if held.err != nil {
		t.Fatalf("the held hybrid search failed: %s: %v", codeOrMessage(held.err), held.err)
	}
	if err := requireHitsFromState("the held hybrid search", held.result.Hits, before, expected); err != nil {
		t.Fatal(err)
	}
	for _, hit := range held.result.Hits {
		title, _ := hit.Document.Get("title")
		if title != "berth "+hit.ID {
			t.Fatalf("the held hybrid search returned %s with the title %v", hit.ID, title)
		}
	}
	everyDocument := heldHybridQuery(query, "")
	everyDocument.Limit = engine.Some(2 * pinnedDocuments)
	after, err := harbour.narsil.Query(harbour.ctx, pinnedIndexName, everyDocument)
	if err != nil || len(after.Hits) != pinnedDocuments {
		t.Fatalf("the hybrid search after the writes returned %d hits, while the index holds %d documents: %v",
			len(after.Hits), pinnedDocuments, err)
	}
	seen := map[string]bool{}
	for _, hit := range after.Hits {
		seen[hit.ID] = true
		vector, carried := returnedEmbedding(hit.Document)
		if !carried || !sameVector(vector, harbour.vectors[hit.ID]) {
			t.Fatalf("the hybrid search after the writes returned %s with a vector that the index no longer holds", hit.ID)
		}
	}
	if seen[expected[0]] || !seen[heldHybridInserted] {
		t.Fatalf("the hybrid search after the writes holds the removed document (%v) or lacks the inserted one (%v)",
			seen[expected[0]], seen[heldHybridInserted])
	}
}
