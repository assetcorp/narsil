package engine_test

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	documentReadsIndex       = "document-reads"
	documentReadsDimension   = 1536
	documentReadsDocuments   = 500
	documentReadsLimit       = 10
	documentReadsBatchSize   = 100
	documentReadsMultipleIDs = 10
)

func documentReadsEngine(b *testing.B) *engine.Narsil {
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		b.Fatalf("the engine refused to start: %v", err)
	}
	b.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func documentReadsSchema(withVectors bool) engine.Schema {
	schema := engine.Schema{"title": engine.FieldString, "body": engine.FieldString, "rank": engine.FieldNumber}
	if withVectors {
		schema["embedding"] = engine.VectorFieldType(documentReadsDimension)
	}
	return schema
}

func documentReadsBatch(prefix string, count int, withVectors bool, source *rand.Rand) []*engine.Document {
	documents := make([]*engine.Document, count)
	for serial := range documents {
		document := engine.NewDocument().Set("id", fmt.Sprintf("%s-%04d", prefix, serial)).
			Set("title", fmt.Sprintf("shared title %d", serial)).
			Set("body", "a shared body of text that every document holds, with a few more words to decode").
			Set("rank", float64(serial))
		if withVectors {
			vector := make([]float32, documentReadsDimension)
			for at := range vector {
				vector[at] = source.Float32()
			}
			document.Set("embedding", vector)
		}
		documents[serial] = document
	}
	return documents
}

func filledDocumentReadsIndex(b *testing.B, withVectors bool) *engine.Narsil {
	ctx := context.Background()
	narsil := documentReadsEngine(b)
	if err := narsil.CreateIndex(ctx, documentReadsIndex, engine.IndexConfig{Language: "english",
		Schema: documentReadsSchema(withVectors)}); err != nil {
		b.Fatalf("the engine refused the index: %v", err)
	}
	documents := documentReadsBatch("doc", documentReadsDocuments, withVectors, rand.New(rand.NewPCG(1, 2)))
	if _, err := narsil.InsertBatch(ctx, documentReadsIndex, documents, engine.InsertOptions{}); err != nil {
		b.Fatalf("the engine refused the documents: %v", err)
	}
	return narsil
}

func documentReadsShapes() []struct {
	name        string
	withVectors bool
} {
	return []struct {
		name        string
		withVectors bool
	}{{"text fields only", false}, {"with a vector field", true}}
}

func BenchmarkGetOneDocument(b *testing.B) {
	for _, shape := range documentReadsShapes() {
		b.Run(shape.name, func(b *testing.B) {
			narsil := filledDocumentReadsIndex(b, shape.withVectors)
			b.ReportAllocs()
			serial := 0
			for b.Loop() {
				id := fmt.Sprintf("doc-%04d", serial%documentReadsDocuments)
				serial++
				document, found, err := narsil.Get(context.Background(), documentReadsIndex, id)
				if err != nil || !found || document == nil {
					b.Fatalf("the engine returned no document under %s: %v", id, err)
				}
			}
		})
	}
}

func BenchmarkGetTenDocuments(b *testing.B) {
	ids := make([]string, documentReadsMultipleIDs)
	for at := range ids {
		ids[at] = fmt.Sprintf("doc-%04d", at*37)
	}
	for _, shape := range documentReadsShapes() {
		b.Run(shape.name, func(b *testing.B) {
			narsil := filledDocumentReadsIndex(b, shape.withVectors)
			b.ReportAllocs()
			for b.Loop() {
				documents, err := narsil.GetMultiple(context.Background(), documentReadsIndex, ids)
				if err != nil || len(documents) != len(ids) {
					b.Fatalf("the engine returned %d documents: %v", len(documents), err)
				}
			}
		})
	}
}

func BenchmarkKeywordSearchReturningTenHits(b *testing.B) {
	params := engine.QueryParams{Term: "shared", Limit: engine.Some(documentReadsLimit)}
	for _, shape := range documentReadsShapes() {
		b.Run(shape.name, func(b *testing.B) {
			narsil := filledDocumentReadsIndex(b, shape.withVectors)
			b.ReportAllocs()
			for b.Loop() {
				result, err := narsil.Query(context.Background(), documentReadsIndex, params)
				if err != nil || len(result.Hits) != documentReadsLimit {
					b.Fatalf("the query returned %d hits: %v", len(result.Hits), err)
				}
			}
		})
	}
}

func BenchmarkInsertBatchOfHundred(b *testing.B) {
	for _, shape := range documentReadsShapes() {
		b.Run(shape.name, func(b *testing.B) {
			ctx := context.Background()
			narsil := documentReadsEngine(b)
			if err := narsil.CreateIndex(ctx, documentReadsIndex, engine.IndexConfig{Language: "english",
				Schema: documentReadsSchema(shape.withVectors)}); err != nil {
				b.Fatalf("the engine refused the index: %v", err)
			}
			source := rand.New(rand.NewPCG(3, 4))
			b.ReportAllocs()
			round := 0
			for b.Loop() {
				documents := documentReadsBatch(fmt.Sprintf("round-%06d", round), documentReadsBatchSize, shape.withVectors, source)
				round++
				if _, err := narsil.InsertBatch(ctx, documentReadsIndex, documents, engine.InsertOptions{}); err != nil {
					b.Fatalf("the engine refused the documents: %v", err)
				}
			}
		})
	}
}
