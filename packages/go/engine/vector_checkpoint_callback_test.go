package engine_test

import (
	"context"
	"fmt"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const checkpointCallbackTimeout = 10 * time.Second

type checkpointContext struct {
	context.Context
	calls atomic.Int64
	at    int64
	act   func()
}

func (c *checkpointContext) reached() {
	if c.calls.Add(1) == c.at {
		c.act()
	}
}

func (c *checkpointContext) Deadline() (time.Time, bool) {
	c.reached()
	return c.Context.Deadline()
}

func (c *checkpointContext) Done() <-chan struct{} {
	c.reached()
	return c.Context.Done()
}

func (c *checkpointContext) Err() error {
	c.reached()
	return c.Context.Err()
}

func (c *checkpointContext) Value(key any) any {
	c.reached()
	return c.Context.Value(key)
}

type checkpointCallbackCase struct {
	rebuild      bool
	checkpointed bool
	filtered     bool
}

func TestVectorSearchKeepsItsFilesWhenAContextCallbackCheckpoints(t *testing.T) {
	for _, rebuild := range []bool{false, true} {
		for _, checkpointed := range []bool{false, true} {
			for _, filtered := range []bool{false, true} {
				scenario := checkpointCallbackCase{rebuild: rebuild, checkpointed: checkpointed, filtered: filtered}
				t.Run(fmt.Sprintf("rebuild-%t/checkpointed-%t/filtered-%t", rebuild, checkpointed, filtered), func(t *testing.T) {
					checkVectorCheckpointCallbacks(t, scenario)
				})
			}
		}
	}
}

func checkVectorCheckpointCallbacks(t *testing.T, scenario checkpointCallbackCase) {
	t.Helper()
	for at := int64(1); ; at++ {
		called := false
		passed := t.Run(fmt.Sprintf("callback-%d", at), func(t *testing.T) {
			narsil, documents := openCheckpointCatalogue(t, scenario)
			var callbackErr error
			callback := &checkpointContext{Context: context.Background(), at: at, act: func() {
				called = true
				callbackErr = checkpointBesideSearch(narsil, scenario, documents)
			}}
			params, expected := checkpointCatalogueQuery(scenario)
			result, err := finishedWithin(t, "the search whose context checkpoints", func() (engine.QueryResult, error) {
				return narsil.Query(callback, "catalogue", params)
			})
			if callbackErr != nil {
				t.Fatalf("the checkpoint callback failed: %v", callbackErr)
			}
			if err != nil {
				t.Fatalf("the query failed after the checkpoint callback: %v", err)
			}
			requireCatalogueHits(t, result, expected)
		})
		if !called || !passed {
			break
		}
	}
}

func openCheckpointCatalogue(t *testing.T, scenario checkpointCallbackCase) (*engine.Narsil, []*engine.Document) {
	t.Helper()
	ctx := context.Background()
	narsil := failedLoadEngine(t, t.TempDir())
	t.Cleanup(func() { shutDown(t, narsil, "after the callback search") })
	index := engine.IndexConfig{
		Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension), "selected": engine.FieldBoolean},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(documentsPastPromotion),
			Storage: engine.VectorStorageDisk, FilterThreshold: engine.Some(1.0)},
	}
	if err := narsil.CreateIndex(ctx, "catalogue", index); err != nil {
		t.Fatal(err)
	}
	documents := make([]*engine.Document, documentsBelowPromotion)
	for position := range documents {
		documents[position] = engine.NewDocument().Set("id", fmt.Sprintf("item-%d", position)).
			Set("embedding", catalogueVector(position)).Set("selected", position < nearestNeighboursChecked)
	}
	if result, err := narsil.InsertBatch(ctx, "catalogue", documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("inserting the vectors failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, "catalogue", "embedding"); err != nil {
		t.Fatal(err)
	}
	if scenario.checkpointed {
		if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
			t.Fatal(err)
		}
		if err := narsil.Update(ctx, "catalogue", "item-0", documents[0], engine.WriteOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	return narsil, documents
}

func checkpointBesideSearch(narsil *engine.Narsil, scenario checkpointCallbackCase, documents []*engine.Document) error {
	bounded, cancel := context.WithTimeout(context.Background(), checkpointCallbackTimeout)
	defer cancel()
	if err := narsil.Update(bounded, "catalogue", "item-0", documents[0], engine.WriteOptions{}); err != nil {
		return err
	}
	if scenario.rebuild {
		if err := narsil.OptimizeVectors(bounded, "catalogue", "embedding"); err != nil {
			return err
		}
	}
	return narsil.Checkpoint(bounded, "catalogue")
}

func checkpointCatalogueQuery(scenario checkpointCallbackCase) (engine.QueryParams, []expectedNeighbour) {
	query := catalogueVector(nearestNeighboursChecked)
	params := engine.QueryParams{
		Mode: engine.SearchVector, Limit: engine.Some(nearestNeighboursChecked), IncludeScores: true,
		Vector: &engine.VectorQueryConfig{Field: "embedding", Value: query},
	}
	expected := cosineOracle(query, documentsBelowPromotion)[:nearestNeighboursChecked]
	if scenario.filtered {
		params.Filters = &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"selected": {Eq: engine.BooleanValue(true)}}}
		expected = cosineOracle(query, nearestNeighboursChecked)
	}
	return params, expected
}

func requireCatalogueHits(t *testing.T, result engine.QueryResult, expected []expectedNeighbour) {
	t.Helper()
	if len(result.Hits) != len(expected) {
		t.Fatalf("the search returned %d hits, expected %d", len(result.Hits), len(expected))
	}
	for position, hit := range result.Hits {
		score, held := hit.Score.Get()
		if hit.ID != expected[position].id || !held || math.Abs(score-expected[position].score) > scoreTolerance {
			t.Fatalf("hit %d is %s at %g, expected %s at %g", position, hit.ID, score, expected[position].id, expected[position].score)
		}
	}
}
