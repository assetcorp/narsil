package engine_test

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestASelectiveVectorSearchScoresMappedVectorsAfterRestart(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := failedLoadEngine(t, directory)
	config := engine.IndexConfig{
		Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension), "selected": engine.FieldBoolean},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(lowPromotionThreshold), Storage: engine.VectorStorageDisk,
			FilterThreshold: engine.Some(1.0)},
	}
	if err := narsil.CreateIndex(ctx, "catalogue", config); err != nil {
		t.Fatal(err)
	}
	documents := make([]*engine.Document, documentsPastPromotion)
	for at := range documents {
		documents[at] = engine.NewDocument().Set("id", fmt.Sprintf("item-%d", at)).
			Set("embedding", catalogueVector(at)).Set("selected", at < nearestNeighboursChecked)
	}
	if result, err := narsil.InsertBatch(ctx, "catalogue", documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("inserting the vectors failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, "catalogue", "embedding"); err != nil {
		t.Fatal(err)
	}
	if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
		t.Fatal(err)
	}
	shutDown(t, narsil, "after the checkpoint")
	reopened := failedLoadEngine(t, directory)
	defer shutDown(t, reopened, "after the mapped search")
	query := catalogueVector(nearestNeighboursChecked)
	result, err := reopened.Query(ctx, "catalogue", engine.QueryParams{
		Mode: engine.SearchVector, Limit: engine.Some(nearestNeighboursChecked), IncludeScores: true,
		Vector:  &engine.VectorQueryConfig{Field: "embedding", Value: query},
		Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"selected": {Eq: engine.BooleanValue(true)}}},
	})
	if err != nil {
		t.Fatalf("scoring the selected vectors after restart failed: %v", err)
	}
	expected := cosineOracle(query, nearestNeighboursChecked)
	if len(result.Hits) != len(expected) {
		t.Fatalf("the search returned %d hits, expected %d", len(result.Hits), len(expected))
	}
	for at, hit := range result.Hits {
		score, held := hit.Score.Get()
		if hit.ID != expected[at].id || !held || math.Abs(score-expected[at].score) > scoreTolerance {
			t.Fatalf("hit %d is %s at %g, expected %s at %g", at, hit.ID, score, expected[at].id, expected[at].score)
		}
	}
}
