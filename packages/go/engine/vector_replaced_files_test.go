package engine_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	replacedFilesAdapter = "held-during-rewrite"
	replacedFilesIndex   = "catalogue"
	replacedFilesScale   = 3
)

func TestACheckpointRemovesTheVectorFileThatASearchHeldThroughARewrite(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	reranker := newHeldReranker(1)
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		RerankAdapters: map[string]engine.RerankAdapter{replacedFilesAdapter: reranker},
		Durability:     &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	defer shutDown(t, narsil, "after the rewrite beside a held search")
	config := engine.IndexConfig{
		Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension), "title": engine.FieldString},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(documentsPastPromotion),
			Storage: engine.VectorStorageDisk},
	}
	if err := narsil.CreateIndex(ctx, replacedFilesIndex, config); err != nil {
		t.Fatal(err)
	}
	documents := make([]*engine.Document, documentsBelowPromotion)
	updates := make([]engine.DocumentUpdate, documentsBelowPromotion)
	for position := range documents {
		id := fmt.Sprintf("item-%d", position)
		documents[position] = engine.NewDocument().Set("id", id).Set("title", "item "+id).
			Set("embedding", catalogueVector(position))
		updates[position] = engine.DocumentUpdate{DocID: id, Document: engine.NewDocument().Set("title", "item "+id).
			Set("embedding", sameDirectionScaled(catalogueVector(position), replacedFilesScale))}
	}
	if result, err := narsil.InsertBatch(ctx, replacedFilesIndex, documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("inserting the vectors failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, replacedFilesIndex, "embedding"); err != nil {
		t.Fatal(err)
	}
	if err := narsil.Checkpoint(ctx, replacedFilesIndex); err != nil {
		t.Fatal(err)
	}
	before := vectorFilesIn(t, directory)
	if len(before) == 0 {
		t.Fatal("the first checkpoint wrote no vector file, so the test checks nothing")
	}
	searched := make(chan error, 1)
	go func() {
		_, err := narsil.Query(ctx, replacedFilesIndex, engine.QueryParams{Mode: engine.SearchVector,
			Limit:  engine.Some(nearestNeighboursChecked),
			Vector: &engine.VectorQueryConfig{Field: "embedding", Value: catalogueVector(nearestNeighboursChecked)},
			Rerank: &engine.RerankConfig{Adapter: replacedFilesAdapter, Fields: []string{"title"}, Query: engine.Some("item")}})
		searched <- err
	}()
	<-reranker.entered
	result, err := narsil.UpdateBatch(ctx, replacedFilesIndex, updates, engine.WriteOptions{})
	if err == nil && len(result.Failed) == 0 {
		err = narsil.OptimizeVectors(ctx, replacedFilesIndex, "embedding")
	}
	close(reranker.release)
	if searchErr := <-searched; searchErr != nil {
		t.Fatalf("the held search failed: %v", searchErr)
	}
	if err != nil || len(result.Failed) != 0 {
		t.Fatalf("rewriting the vectors beside the held search failed: %v %+v", err, result.Failed)
	}
	if err := narsil.Checkpoint(ctx, replacedFilesIndex); err != nil {
		t.Fatalf("the checkpoint after the search failed: %v", err)
	}
	after := vectorFilesIn(t, directory)
	if len(after) == 0 {
		t.Fatal("the checkpoint after the rewrite left no vector file, so the index lost its vectors")
	}
	for path := range before {
		if _, left := after[path]; left {
			t.Fatalf("%s holds only replaced vectors, yet it stayed on disk after the search ended and a checkpoint ran", path)
		}
	}
}
