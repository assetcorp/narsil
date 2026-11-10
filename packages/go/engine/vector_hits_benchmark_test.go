package engine_test

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	vectorHitsIndex     = "vector-hits"
	vectorHitsDimension = 1536
	vectorHitsDocuments = 500
	vectorHitsLimit     = 10
)

func BenchmarkKeywordSearchReturningTenHitsWithVectors(b *testing.B) {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		b.Fatalf("the engine refused to start: %v", err)
	}
	b.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	if err := narsil.CreateIndex(ctx, vectorHitsIndex, engine.IndexConfig{Language: "english", Schema: engine.Schema{
		"title": engine.FieldString, "body": engine.FieldString, "rank": engine.FieldNumber,
		"embedding": engine.VectorFieldType(vectorHitsDimension)}}); err != nil {
		b.Fatalf("the engine refused the index: %v", err)
	}
	source := rand.New(rand.NewPCG(1, 2))
	documents := make([]*engine.Document, vectorHitsDocuments)
	for serial := range documents {
		vector := make([]float32, vectorHitsDimension)
		for at := range vector {
			vector[at] = source.Float32()
		}
		documents[serial] = engine.NewDocument().Set("id", fmt.Sprintf("doc-%04d", serial)).
			Set("title", fmt.Sprintf("shared title %d", serial)).
			Set("body", "a shared body of text that every document holds, with a few more words to decode").
			Set("rank", float64(serial)).Set("embedding", vector)
	}
	if _, err := narsil.InsertBatch(ctx, vectorHitsIndex, documents, engine.InsertOptions{}); err != nil {
		b.Fatalf("the engine refused the documents: %v", err)
	}
	b.Run("query", func(b *testing.B) { measureTenHits(b, narsil, false) })
	b.Run("query and read every hit", func(b *testing.B) { measureTenHits(b, narsil, true) })
}

func measureTenHits(b *testing.B, narsil *engine.Narsil, readsHits bool) {
	params := engine.QueryParams{Term: "shared", Limit: engine.Some(vectorHitsLimit)}
	b.ReportAllocs()
	for b.Loop() {
		result, err := narsil.Query(context.Background(), vectorHitsIndex, params)
		if err != nil || len(result.Hits) != vectorHitsLimit {
			b.Fatalf("the query returned %d hits: %v", len(result.Hits), err)
		}
		if !readsHits {
			continue
		}
		for _, hit := range result.Hits {
			if body, found := hit.Document.Get("body"); !found || body == "" {
				b.Fatalf("the hit %s holds no body", hit.ID)
			}
		}
	}
}
