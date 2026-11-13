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

func (c *checkpointContext) Err() error {
	if c.calls.Add(1) == c.at {
		c.act()
	}
	return c.Context.Err()
}

func TestVectorSearchKeepsItsFilesWhenAContextCallbackCheckpoints(t *testing.T) {
	for _, rebuild := range []bool{false, true} {
		t.Run(fmt.Sprintf("rebuild-%t", rebuild), func(t *testing.T) {
			for _, checkpointed := range []bool{false, true} {
				t.Run(fmt.Sprintf("checkpointed-%t", checkpointed), func(t *testing.T) {
					checkVectorCheckpointCallbacks(t, rebuild, checkpointed)
				})
			}
		})
	}
}

func checkVectorCheckpointCallbacks(t *testing.T, rebuild, checkpointed bool) {
	t.Helper()
	for at := int64(1); ; at++ {
		called := false
		passed := t.Run(fmt.Sprintf("callback-%d", at), func(t *testing.T) {
			ctx := context.Background()
			narsil := failedLoadEngine(t, t.TempDir())
			defer shutDown(t, narsil, "after the callback search")
			config := engine.IndexConfig{
				Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension), "selected": engine.FieldBoolean},
				VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(documentsPastPromotion),
					Storage: engine.VectorStorageDisk, FilterThreshold: engine.Some(1.0)},
			}
			if err := narsil.CreateIndex(ctx, "catalogue", config); err != nil {
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
			if checkpointed {
				if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
					t.Fatal(err)
				}
				if err := narsil.Update(ctx, "catalogue", "item-0", documents[0], engine.WriteOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			var callbackErr error
			callback := &checkpointContext{Context: ctx, at: at, act: func() {
				called = true
				bounded, cancel := context.WithTimeout(ctx, checkpointCallbackTimeout)
				defer cancel()
				if rebuild {
					callbackErr = narsil.OptimizeVectors(bounded, "catalogue", "embedding")
				}
				if callbackErr == nil {
					callbackErr = narsil.Checkpoint(bounded, "catalogue")
				}
			}}
			query := catalogueVector(nearestNeighboursChecked)
			result, err := narsil.Query(callback, "catalogue", engine.QueryParams{
				Mode: engine.SearchVector, Limit: engine.Some(nearestNeighboursChecked), IncludeScores: true,
				Vector:  &engine.VectorQueryConfig{Field: "embedding", Value: query},
				Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"selected": {Eq: engine.BooleanValue(true)}}},
			})
			if callbackErr != nil {
				t.Fatalf("the checkpoint callback failed: %v", callbackErr)
			}
			if err != nil {
				t.Fatalf("the query failed after the checkpoint callback: %v", err)
			}
			expected := cosineOracle(query, nearestNeighboursChecked)
			if len(result.Hits) != len(expected) {
				t.Fatalf("the search returned %d hits, expected %d", len(result.Hits), len(expected))
			}
			for position, hit := range result.Hits {
				score, held := hit.Score.Get()
				if hit.ID != expected[position].id || !held || math.Abs(score-expected[position].score) > scoreTolerance {
					t.Fatalf("hit %d is %s at %g, expected %s at %g", position, hit.ID, score, expected[position].id, expected[position].score)
				}
			}
		})
		if !called || !passed {
			break
		}
	}
}
