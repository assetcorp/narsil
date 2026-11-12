package engine_test

import (
	"bytes"
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	callbackIndex           = "documents"
	callbackDeadline        = 10 * time.Second
	callbackShutdownWait    = 5 * time.Second
	callbackRerankTimeout   = 5 * time.Second
	callbackSimilarityFloor = 0.9
	callbackRerunsRefused   = 3
)

var (
	wantedVector = []float32{0, 1}
	decoyVector  = []float32{1, 0}
)

type callbackEmbedder struct {
	dimensions int
	embed      func(input string) ([]float32, error)
}

func (e *callbackEmbedder) Embed(_ context.Context, input string, _ engine.EmbeddingPurpose) ([]float32, error) {
	return e.embed(input)
}

func (e *callbackEmbedder) Dimensions() int {
	return e.dimensions
}

type callbackReranker struct {
	rerank func(query string, documents []string) ([]float64, error)
}

func (r *callbackReranker) Rerank(_ context.Context, query string, documents []string) ([]float64, error) {
	return r.rerank(query, documents)
}

func fixedEmbedder(vector []float32) *callbackEmbedder {
	return &callbackEmbedder{dimensions: len(vector), embed: func(string) ([]float32, error) {
		return append([]float32(nil), vector...), nil
	}}
}

func startedForCallbacks(t *testing.T, durable bool) *engine.Narsil {
	t.Helper()
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		RerankTimeout: engine.Some(callbackRerankTimeout)}
	if durable {
		config.Durability = &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync}
	}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), callbackShutdownWait)
		defer cancel()
		_ = narsil.Shutdown(ctx)
	})
	return narsil
}

func embeddedTitleConfig(adapter string) engine.IndexConfig {
	return engine.IndexConfig{
		Schema:      engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(len(wantedVector))},
		TextStorage: engine.TextStorageDisk,
		Embedding: &engine.EmbeddingFieldConfig{Adapter: engine.NamedEmbeddingAdapter(adapter),
			Fields: map[string]engine.EmbeddingSource{"embedding": engine.EmbedField("title")}},
	}
}

func insertTitled(t *testing.T, narsil *engine.Narsil, id string, vector []float32) {
	t.Helper()
	document := engine.DocumentFromMap(map[string]any{"title": id, "embedding": vector})
	if _, err := narsil.Insert(context.Background(), callbackIndex, document, id, engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused %s with %s: %v", id, codeOrMessage(err), err)
	}
}

func snapshotOf(t *testing.T, narsil *engine.Narsil, indexName string) []byte {
	t.Helper()
	var archive bytes.Buffer
	if err := narsil.Snapshot(context.Background(), indexName, engine.SnapshotOptions{}, &archive); err != nil {
		t.Fatalf("the snapshot of %s failed with %s: %v", indexName, codeOrMessage(err), err)
	}
	return archive.Bytes()
}

func restoreArchive(narsil *engine.Narsil, indexName string, archive []byte) error {
	return narsil.Restore(context.Background(), indexName, bytes.NewReader(archive))
}

func vectorTextSearch() engine.QueryParams {
	return engine.QueryParams{Vector: &engine.VectorQueryConfig{Field: "embedding", Text: engine.Some("search"),
		Similarity: engine.Some(callbackSimilarityFloor)}}
}

func finishedWithin[R any](t *testing.T, label string, call func() (R, error)) (R, error) {
	t.Helper()
	type outcome struct {
		result R
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := call()
		done <- outcome{result: result, err: err}
	}()
	select {
	case finished := <-done:
		return finished.result, finished.err
	case <-time.After(callbackDeadline):
		t.Fatalf("%s did not return within %s", label, callbackDeadline)
		var empty R
		return empty, nil
	}
}

func sourceWithReplacementAdapter(t *testing.T) []byte {
	t.Helper()
	source := startedForCallbacks(t, true)
	if err := source.RegisterEmbeddingAdapter("replacement", fixedEmbedder(wantedVector)); err != nil {
		t.Fatalf("registering the replacement adapter failed: %v", err)
	}
	if err := source.CreateIndex(context.Background(), callbackIndex, embeddedTitleConfig("replacement")); err != nil {
		t.Fatalf("the source refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, source, "wanted", wantedVector)
	insertTitled(t, source, "decoy-one", decoyVector)
	insertTitled(t, source, "decoy-two", decoyVector)
	return snapshotOf(t, source, callbackIndex)
}

func requireCurrentAdapterAnswers(t *testing.T, preflight bool) {
	archive := sourceWithReplacementAdapter(t)
	target := startedForCallbacks(t, true)
	original := &callbackEmbedder{dimensions: len(decoyVector), embed: func(string) ([]float32, error) {
		if err := restoreArchive(target, callbackIndex, archive); err != nil {
			return nil, err
		}
		return append([]float32(nil), decoyVector...), nil
	}}
	if err := target.RegisterEmbeddingAdapter("original", original); err != nil {
		t.Fatalf("registering the original adapter failed: %v", err)
	}
	var replacements atomic.Int32
	replacing := &callbackEmbedder{dimensions: len(decoyVector), embed: func(string) ([]float32, error) {
		if err := target.RegisterEmbeddingAdapter("replacement", fixedEmbedder(wantedVector)); err != nil {
			return nil, err
		}
		replacements.Add(1)
		return append([]float32(nil), decoyVector...), nil
	}}
	if err := target.RegisterEmbeddingAdapter("replacement", replacing); err != nil {
		t.Fatalf("registering the self-replacing adapter failed: %v", err)
	}
	ctx := context.Background()
	if err := target.CreateIndex(ctx, callbackIndex, embeddedTitleConfig("original")); err != nil {
		t.Fatalf("the target refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, target, "original", decoyVector)
	if err := target.Checkpoint(ctx, callbackIndex); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	if preflight {
		counted, err := finishedWithin(t, "the preflight", func() (engine.PreflightResult, error) {
			return target.Preflight(ctx, callbackIndex, vectorTextSearch())
		})
		if err != nil {
			t.Fatalf("the preflight failed with %s: %v", codeOrMessage(err), err)
		}
		if counted.Count != 1 {
			t.Fatalf("the preflight counted %d documents, and the current adapter matches only wanted", counted.Count)
		}
	} else {
		answered, err := finishedWithin(t, "the query", func() (engine.QueryResult, error) {
			return target.Query(ctx, callbackIndex, vectorTextSearch())
		})
		if err != nil {
			t.Fatalf("the query failed with %s: %v", codeOrMessage(err), err)
		}
		if len(answered.Hits) != 1 || answered.Hits[0].ID != "wanted" {
			t.Fatalf("the query returned %+v, and the current adapter matches only wanted", hitIDs(answered.Hits))
		}
	}
	if got := replacements.Load(); got != 1 {
		t.Fatalf("the self-replacing adapter embedded %d times, expected 1", got)
	}
	fresh, err := target.Query(ctx, callbackIndex, vectorTextSearch())
	if err != nil {
		t.Fatalf("the later query failed with %s: %v", codeOrMessage(err), err)
	}
	if len(fresh.Hits) != 1 || fresh.Hits[0].ID != "wanted" {
		t.Fatalf("the later query returned %+v, expected only wanted", hitIDs(fresh.Hits))
	}
}

func hitIDs(hits []engine.Hit) []string {
	ids := make([]string, len(hits))
	for at, hit := range hits {
		ids[at] = hit.ID
	}
	return ids
}

func TestAQueryRechecksTheAdapterAfterARestoredAdapterReplacesItself(t *testing.T) {
	requireCurrentAdapterAnswers(t, false)
}

func TestAPreflightRechecksTheAdapterAfterARestoredAdapterReplacesItself(t *testing.T) {
	requireCurrentAdapterAnswers(t, true)
}

func requireEmbeddingFromRerank(t *testing.T, preflight bool) {
	ctx := context.Background()
	source := startedForCallbacks(t, true)
	if err := source.RegisterEmbeddingAdapter("restoring", fixedEmbedder(wantedVector)); err != nil {
		t.Fatalf("registering the source adapter failed: %v", err)
	}
	if err := source.CreateIndex(ctx, callbackIndex, embeddedTitleConfig("restoring")); err != nil {
		t.Fatalf("the source refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, source, "wanted", wantedVector)
	archive := snapshotOf(t, source, callbackIndex)

	target := startedForCallbacks(t, true)
	entered := make(chan struct{}, callbackRerunsRefused)
	restoring := &callbackEmbedder{dimensions: len(wantedVector), embed: func(string) ([]float32, error) {
		select {
		case entered <- struct{}{}:
		default:
		}
		if err := restoreArchive(target, callbackIndex, archive); err != nil {
			return nil, err
		}
		return append([]float32(nil), wantedVector...), nil
	}}
	if err := target.RegisterEmbeddingAdapter("restoring", restoring); err != nil {
		t.Fatalf("registering the restoring adapter failed: %v", err)
	}
	if err := target.CreateIndex(ctx, callbackIndex, embeddedTitleConfig("restoring")); err != nil {
		t.Fatalf("the target refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertTitled(t, target, "wanted", wantedVector)
	if err := target.Checkpoint(ctx, callbackIndex); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	counts := make(chan int, callbackRerunsRefused)
	var reranks atomic.Int32
	searching := &callbackReranker{rerank: func(_ string, documents []string) ([]float64, error) {
		reranks.Add(1)
		count := 0
		if preflight {
			counted, err := target.Preflight(ctx, callbackIndex, vectorTextSearch())
			if err != nil {
				return nil, err
			}
			count = counted.Count
		} else {
			answered, err := target.Query(ctx, callbackIndex, vectorTextSearch())
			if err != nil {
				return nil, err
			}
			count = answered.Count
		}
		select {
		case counts <- count:
		default:
		}
		scores := make([]float64, len(documents))
		for at := range scores {
			scores[at] = 1
		}
		return scores, nil
	}}
	if err := target.RegisterRerankAdapter("searching", searching); err != nil {
		t.Fatalf("registering the searching reranker failed: %v", err)
	}
	_, err := finishedWithin(t, "the reranked query", func() (engine.QueryResult, error) {
		return target.Query(ctx, callbackIndex, engine.QueryParams{Term: "wanted",
			Rerank: &engine.RerankConfig{Adapter: "searching", Fields: []string{"title"}}})
	})
	select {
	case <-entered:
	default:
		t.Fatal("the nested search never reached its embedding adapter")
	}
	select {
	case count := <-counts:
		if count != 1 {
			t.Fatalf("the nested search counted %d documents, expected 1", count)
		}
	default:
		t.Fatal("the nested search never returned to the reranker")
	}
	if code := engine.ErrorCode(err); code != engine.CodeWorkerBusy {
		t.Fatalf("the reranked query returned %s, expected %s once every rerank call restores: %v", codeOrMessage(err),
			engine.CodeWorkerBusy, err)
	}
	if got := reranks.Load(); got != callbackRerunsRefused {
		t.Fatalf("the reranker ran %d times, expected %d", got, callbackRerunsRefused)
	}
}

func TestAQueryRefusesOnceAnEmbeddingFromEachRerankRestoresTheSameIndex(t *testing.T) {
	requireEmbeddingFromRerank(t, false)
}

func TestAPreflightEmbeddingFromEachRerankRestoringTheSameIndexRefusesTheQuery(t *testing.T) {
	requireEmbeddingFromRerank(t, true)
}
