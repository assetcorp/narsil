package engine_test

import (
	"context"
	"fmt"
	"io/fs"
	"math"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
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

func sameDirectionTwiceAsLong(vector []float32) []float32 {
	doubled := make([]float32, len(vector))
	for at, value := range vector {
		doubled[at] = 2 * value
	}
	return doubled
}

type garbageDuringSearch struct {
	collected     int
	keptForSearch int
}

func checkpointGarbageDuringSearch(t *testing.T, at int64) (garbageDuringSearch, bool) {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	narsil := failedLoadEngine(t, directory)
	defer shutDown(t, narsil, "after the search that spanned a checkpoint")
	config := engine.IndexConfig{
		Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension), "selected": engine.FieldBoolean},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(documentsPastPromotion),
			Storage: engine.VectorStorageDisk, FilterThreshold: engine.Some(1.0)},
	}
	if err := narsil.CreateIndex(ctx, "catalogue", config); err != nil {
		t.Fatal(err)
	}
	documents := make([]*engine.Document, documentsBelowPromotion)
	updates := make([]engine.DocumentUpdate, documentsBelowPromotion)
	for position := range documents {
		id := fmt.Sprintf("item-%d", position)
		documents[position] = engine.NewDocument().Set("id", id).
			Set("embedding", catalogueVector(position)).Set("selected", position < nearestNeighboursChecked)
		updates[position] = engine.DocumentUpdate{DocID: id, Document: engine.NewDocument().
			Set("embedding", sameDirectionTwiceAsLong(catalogueVector(position))).Set("selected", position < nearestNeighboursChecked)}
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
	first := vectorFilesIn(t, directory)
	if result, err := narsil.UpdateBatch(ctx, "catalogue", updates, engine.WriteOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("rewriting every vector failed: %v %+v", err, result.Failed)
	}
	called := false
	var during map[string]struct{}
	var callbackErr error
	callback := &checkpointContext{Context: ctx, at: at, act: func() {
		called = true
		bounded, cancel := context.WithTimeout(ctx, checkpointCallbackTimeout)
		defer cancel()
		callbackErr = narsil.OptimizeVectors(bounded, "catalogue", "embedding")
		if callbackErr == nil {
			callbackErr = narsil.Checkpoint(bounded, "catalogue")
		}
		during = vectorFilesIn(t, directory)
	}}
	query := catalogueVector(nearestNeighboursChecked)
	result, err := narsil.Query(callback, "catalogue", engine.QueryParams{
		Mode: engine.SearchVector, Limit: engine.Some(nearestNeighboursChecked), IncludeScores: true,
		Vector:  &engine.VectorQueryConfig{Field: "embedding", Value: query},
		Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"selected": {Eq: engine.BooleanValue(true)}}},
	})
	if callbackErr != nil {
		t.Fatalf("the checkpoint during the search failed: %v", callbackErr)
	}
	if err != nil {
		t.Fatalf("the search that spanned a checkpoint failed: %v", err)
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
	if !called {
		return garbageDuringSearch{}, false
	}
	if err := narsil.Checkpoint(ctx, "catalogue"); err != nil {
		t.Fatalf("the checkpoint after the search failed: %v", err)
	}
	last := vectorFilesIn(t, directory)
	outcome := garbageDuringSearch{}
	for path := range first {
		if _, left := last[path]; left {
			t.Fatalf("%s holds only replaced vectors, yet it stayed on disk after the search ended and another checkpoint ran", path)
		}
		outcome.collected++
		if _, kept := during[path]; kept {
			outcome.keptForSearch++
		}
	}
	if outcome.collected == 0 {
		t.Fatal("rebuilding the rewritten vectors left no vector file to collect, so the test checked nothing")
	}
	return outcome, true
}

func TestACheckpointKeepsTheVectorFilesThatARunningSearchStillReads(t *testing.T) {
	keptForSearch := 0
	for at := int64(1); ; at++ {
		var outcome garbageDuringSearch
		called := false
		passed := t.Run(fmt.Sprintf("callback-%d", at), func(t *testing.T) {
			outcome, called = checkpointGarbageDuringSearch(t, at)
		})
		if !passed {
			return
		}
		keptForSearch += outcome.keptForSearch
		if !called {
			break
		}
	}
	if keptForSearch == 0 {
		t.Fatal("every checkpoint during the search removed a vector file that the search still read")
	}
}
