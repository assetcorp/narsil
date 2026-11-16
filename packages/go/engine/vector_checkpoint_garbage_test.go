package engine_test

import (
	"context"
	"fmt"
	"io/fs"
	"math"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	searchesBesideCheckpoints = 4
	rewritesBesideSearches    = 6
)

var embeddingVectorFileName = regexp.MustCompile(`^vec-embedding-[0-9a-z]+-f[0-9]+$`)

func vectorFilesIn(t *testing.T, directory string) map[string]struct{} {
	t.Helper()
	found := map[string]struct{}{}
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && embeddingVectorFileName.MatchString(entry.Name()) {
			found[path] = struct{}{}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("listing the vector files failed: %v", err)
	}
	return found
}

func sameDirectionScaled(vector []float32, factor float32) []float32 {
	scaled := make([]float32, len(vector))
	for at, value := range vector {
		scaled[at] = factor * value
	}
	return scaled
}

func searchUntilStopped(narsil *engine.Narsil, stop *atomic.Bool, searched *atomic.Int64) error {
	query := catalogueVector(nearestNeighboursChecked)
	expected := cosineOracle(query, nearestNeighboursChecked)
	for !stop.Load() {
		result, err := narsil.Query(context.Background(), "catalogue", engine.QueryParams{
			Mode: engine.SearchVector, Limit: engine.Some(nearestNeighboursChecked), IncludeScores: true,
			Vector:  &engine.VectorQueryConfig{Field: "embedding", Value: query},
			Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"selected": {Eq: engine.BooleanValue(true)}}},
		})
		if err != nil {
			return fmt.Errorf("a search beside the checkpoints failed: %w", err)
		}
		if len(result.Hits) != len(expected) {
			return fmt.Errorf("a search beside the checkpoints returned %d hits, expected %d", len(result.Hits), len(expected))
		}
		for position, hit := range result.Hits {
			score, held := hit.Score.Get()
			if hit.ID != expected[position].id || !held || math.Abs(score-expected[position].score) > scoreTolerance {
				return fmt.Errorf("hit %d is %s at %g, expected %s at %g", position, hit.ID, score,
					expected[position].id, expected[position].score)
			}
		}
		searched.Add(1)
	}
	return nil
}

func rewriteRebuildAndCheckpoint(ctx context.Context, narsil *engine.Narsil, factor float32) error {
	updates := make([]engine.DocumentUpdate, documentsBelowPromotion)
	for position := range updates {
		updates[position] = engine.DocumentUpdate{DocID: fmt.Sprintf("item-%d", position), Document: engine.NewDocument().
			Set("embedding", sameDirectionScaled(catalogueVector(position), factor)).
			Set("selected", position < nearestNeighboursChecked)}
	}
	if result, err := narsil.UpdateBatch(ctx, "catalogue", updates, engine.WriteOptions{}); err != nil || len(result.Failed) != 0 {
		return fmt.Errorf("rewriting every vector failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, "catalogue", "embedding"); err != nil {
		return err
	}
	return narsil.Checkpoint(ctx, "catalogue")
}

func TestACheckpointKeepsTheVectorFilesThatARunningSearchStillReads(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := failedLoadEngine(t, directory)
	defer shutDown(t, narsil, "after the searches that spanned the checkpoints")
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
	if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
		t.Fatal(err)
	}
	replaced := vectorFilesIn(t, directory)
	var stop atomic.Bool
	var searched atomic.Int64
	failures := make([]error, searchesBesideCheckpoints)
	var searches sync.WaitGroup
	for searcher := range searchesBesideCheckpoints {
		searches.Go(func() { failures[searcher] = searchUntilStopped(narsil, &stop, &searched) })
	}
	var rewriteErr error
	for round := range rewritesBesideSearches {
		if rewriteErr = rewriteRebuildAndCheckpoint(ctx, narsil, float32(round+2)); rewriteErr != nil {
			break
		}
	}
	stop.Store(true)
	searches.Wait()
	if rewriteErr != nil {
		t.Fatalf("a checkpoint beside the searches failed: %v", rewriteErr)
	}
	for _, failure := range failures {
		if failure != nil {
			t.Fatal(failure)
		}
	}
	if searched.Load() == 0 {
		t.Fatal("no search finished beside the checkpoints, so the test checked nothing")
	}
	if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
		t.Fatalf("the checkpoint after the searches failed: %v", err)
	}
	last := vectorFilesIn(t, directory)
	if len(last) == 0 {
		t.Fatal("the last checkpoint left no vector file, so the index lost its vectors")
	}
	for path := range replaced {
		if _, left := last[path]; left {
			t.Fatalf("%s holds only replaced vectors, yet it stayed on disk after every search ended and another checkpoint ran", path)
		}
	}
}
