package engine_test

import (
	"context"
	"maps"
	"math"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	trailIndex                             = "trails"
	trailSearchedWord                      = "river"
	rerankCallsWithOneRestore              = 2
	queryEmbeddingsAcrossOneAdapterChange  = 2
	restoringRerankAdapter                 = "restoring"
	trailEmbeddingDimensions               = 2
	trailCategoryFacet                     = "category"
	unlimitedRestores                      = math.MaxInt32
	restoredDocumentThatOnlyTheArchiveHeld = "restored-current"
)

type trail struct {
	id, title, category string
}

var replacedTrails = []trail{
	{"shared", "river stone", "old"},
	{"replaced-bend", "river bend", "old"},
	{"replaced-mouth", "river mouth wide", "old"},
	{"replaced-quiet", "quiet river", "old"},
}

var restoredTrails = []trail{
	{"shared", "river stone path", "trail"},
	{"restored-crossing", "river crossing", "trail"},
	{"restored-delta", "river delta marsh", "wetland"},
	{"restored-shore", "lake shore", "wetland"},
	{"restored-current", "slow river current water", "wetland"},
}

func trailConfig(adapter string) engine.IndexConfig {
	schema := engine.Schema{"title": engine.FieldString, "category": engine.FieldString}
	if adapter == "" {
		return engine.IndexConfig{Schema: schema}
	}
	schema["embedding"] = engine.VectorFieldType(trailEmbeddingDimensions)
	return engine.IndexConfig{Schema: schema, Embedding: &engine.EmbeddingFieldConfig{
		Adapter: engine.NamedEmbeddingAdapter(adapter),
		Fields:  map[string]engine.EmbeddingSource{"embedding": engine.EmbedField("title")}}}
}

func fillTrails(t *testing.T, narsil *engine.Narsil, config engine.IndexConfig, trails []trail) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, trailIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	for _, held := range trails {
		document := engine.DocumentFromMap(map[string]any{"title": held.title, "category": held.category})
		if _, err := narsil.Insert(ctx, trailIndex, document, held.id, engine.InsertOptions{}); err != nil {
			t.Fatalf("the engine refused %s with %s: %v", held.id, codeOrMessage(err), err)
		}
	}
}

func holdsSearchedWord(text string) bool {
	return slices.Contains(strings.Fields(text), trailSearchedWord)
}

func wordEmbedding(onQuery func() error) *callbackEmbedder {
	return &callbackEmbedder{dimensions: trailEmbeddingDimensions, embed: func(input string) ([]float32, error) {
		if input == trailSearchedWord {
			if err := onQuery(); err != nil {
				return nil, err
			}
		}
		if holdsSearchedWord(input) {
			return []float32{1, 0}, nil
		}
		return []float32{0, 1}, nil
	}}
}

func titleLengthScore(title string) float64 {
	return float64(utf8.RuneCountInString(title))
}

func registerRestoringReranker(t *testing.T, narsil *engine.Narsil, archive []byte, restores int32) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	reranker := &callbackReranker{rerank: func(_ string, documents []string) ([]float64, error) {
		if calls.Add(1) <= restores {
			if err := restoreArchive(narsil, trailIndex, archive); err != nil {
				return nil, err
			}
		}
		scores := make([]float64, len(documents))
		for at, text := range documents {
			scores[at] = titleLengthScore(text)
		}
		return scores, nil
	}}
	if err := narsil.RegisterRerankAdapter(restoringRerankAdapter, reranker); err != nil {
		t.Fatalf("registering the restoring reranker failed: %v", err)
	}
	return &calls
}

func rerankedTrailSearch() engine.QueryParams {
	return engine.QueryParams{Term: trailSearchedWord, Facets: engine.FacetConfig{trailCategoryFacet: {}},
		Rerank: &engine.RerankConfig{Adapter: restoringRerankAdapter, Fields: []string{"title"}}}
}

func archiveOfTrails(t *testing.T, config engine.IndexConfig, prepare func(*engine.Narsil)) []byte {
	t.Helper()
	source := startedForCallbacks(t, false)
	if prepare != nil {
		prepare(source)
	}
	fillTrails(t, source, config, restoredTrails)
	return snapshotOf(t, source, trailIndex)
}

func requireRestoredTrailPage(t *testing.T, result engine.QueryResult) {
	t.Helper()
	matching := make([]trail, 0, len(restoredTrails))
	for _, held := range restoredTrails {
		if holdsSearchedWord(held.title) {
			matching = append(matching, held)
		}
	}
	slices.SortStableFunc(matching, func(left, right trail) int {
		return int(titleLengthScore(right.title) - titleLengthScore(left.title))
	})
	categories := map[string]int{}
	for _, held := range matching {
		categories[held.category]++
	}
	if len(result.Hits) != len(matching) {
		t.Fatalf("the page holds %v, and the restored index ranks %d matching trails", hitIDs(result.Hits), len(matching))
	}
	for at, hit := range result.Hits {
		expected := matching[at]
		if hit.ID != expected.id {
			t.Fatalf("the page holds %v, and the restored index ranks %s at %d", hitIDs(result.Hits), expected.id, at)
		}
		title, _ := hit.Document.Get("title")
		category, _ := hit.Document.Get("category")
		if title != expected.title || category != expected.category {
			t.Fatalf("hit %s carries %v and %v, and the restored index holds %q and %q", hit.ID, title, category,
				expected.title, expected.category)
		}
	}
	if result.Count != len(matching) {
		t.Fatalf("the page counts %d matches, and the restored index holds %d", result.Count, len(matching))
	}
	facet, found := result.Facets[trailCategoryFacet]
	if !found || len(result.Facets) != 1 {
		t.Fatalf("the query asked for one category facet, and the page holds %+v", result.Facets)
	}
	counted := map[string]int{}
	for _, value := range facet.Values {
		counted[value.Value] = value.Count
	}
	if !maps.Equal(counted, categories) {
		t.Fatalf("the page counts categories %v, and the restored index holds %v", counted, categories)
	}
}

func TestARerankedQueryWhoseIndexOneRestoreReplacesReturnsAPageOfTheRestoredIndex(t *testing.T) {
	archive := archiveOfTrails(t, trailConfig(""), nil)
	target := startedForCallbacks(t, false)
	fillTrails(t, target, trailConfig(""), replacedTrails)
	calls := registerRestoringReranker(t, target, archive, 1)
	result, err := finishedWithin(t, "the reranked query", func() (engine.QueryResult, error) {
		return target.Query(context.Background(), trailIndex, rerankedTrailSearch())
	})
	if err != nil {
		t.Fatalf("the reranked query failed with %s: %v", codeOrMessage(err), err)
	}
	requireRestoredTrailPage(t, result)
	if got := calls.Load(); got != rerankCallsWithOneRestore {
		t.Fatalf("the reranker ran %d times, expected %d", got, rerankCallsWithOneRestore)
	}
}

func TestARerankedQueryRefusesWithWorkerBusyOnceARestoreReplacesItsIndexDuringEveryRerankCall(t *testing.T) {
	archive := archiveOfTrails(t, trailConfig(""), nil)
	target := startedForCallbacks(t, false)
	fillTrails(t, target, trailConfig(""), replacedTrails)
	calls := registerRestoringReranker(t, target, archive, unlimitedRestores)
	_, err := finishedWithin(t, "the reranked query", func() (engine.QueryResult, error) {
		return target.Query(context.Background(), trailIndex, rerankedTrailSearch())
	})
	if code := engine.ErrorCode(err); code != engine.CodeWorkerBusy {
		t.Fatalf("the reranked query returned %s, expected %s: %v", codeOrMessage(err), engine.CodeWorkerBusy, err)
	}
	if got := calls.Load(); got != callbackRerunsRefused {
		t.Fatalf("the reranker ran %d times, expected %d", got, callbackRerunsRefused)
	}
	restored, found, err := target.Get(context.Background(), trailIndex, restoredDocumentThatOnlyTheArchiveHeld)
	if err != nil || !found {
		t.Fatalf("the restored document is missing after the refusal: %v", err)
	}
	if title, _ := restored.Get("title"); title != "slow river current water" {
		t.Fatalf("the restored document holds title %v", title)
	}
}

func TestOnlyRerankCallsThatARestoreInterruptedCountTowardTheRefusal(t *testing.T) {
	archive := archiveOfTrails(t, trailConfig("later"), func(source *engine.Narsil) {
		if err := source.RegisterEmbeddingAdapter("later", wordEmbedding(func() error { return nil })); err != nil {
			t.Fatalf("registering the source adapter failed: %v", err)
		}
	})
	target := startedForCallbacks(t, false)
	var embeddings atomic.Int32
	earlier := wordEmbedding(func() error {
		embeddings.Add(1)
		return restoreArchive(target, trailIndex, archive)
	})
	if err := target.RegisterEmbeddingAdapter("earlier", earlier); err != nil {
		t.Fatalf("registering the earlier adapter failed: %v", err)
	}
	later := wordEmbedding(func() error {
		embeddings.Add(1)
		return nil
	})
	if err := target.RegisterEmbeddingAdapter("later", later); err != nil {
		t.Fatalf("registering the later adapter failed: %v", err)
	}
	fillTrails(t, target, trailConfig("earlier"), replacedTrails)
	calls := registerRestoringReranker(t, target, archive, callbackRerunsRefused-1)
	params := rerankedTrailSearch()
	params.Vector = &engine.VectorQueryConfig{Field: "embedding", Text: engine.Some(trailSearchedWord),
		Similarity: engine.Some(callbackSimilarityFloor)}
	params.Document = engine.ExcludeFields("embedding")
	result, err := finishedWithin(t, "the reranked query", func() (engine.QueryResult, error) {
		return target.Query(context.Background(), trailIndex, params)
	})
	if err != nil {
		t.Fatalf("the reranked query failed with %s: %v", codeOrMessage(err), err)
	}
	requireRestoredTrailPage(t, result)
	if got := calls.Load(); got != callbackRerunsRefused {
		t.Fatalf("the reranker ran %d times, expected %d", got, callbackRerunsRefused)
	}
	if got := embeddings.Load(); got != queryEmbeddingsAcrossOneAdapterChange {
		t.Fatalf("the query embedded its text %d times, expected %d", got, queryEmbeddingsAcrossOneAdapterChange)
	}
}
