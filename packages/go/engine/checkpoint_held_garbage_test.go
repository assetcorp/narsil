package engine_test

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	heldGarbageIndex    = "catalogue"
	heldGarbageScale    = 5
	heldGarbagePoll     = time.Millisecond
	heldGarbageDeadline = time.Minute
)

func heldGarbageEngine(ctx context.Context, directory string) (*engine.Narsil, error) {
	return engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}})
}

func newVectorFileWritten(t *testing.T, directory string, before map[string]struct{}) bool {
	t.Helper()
	for path := range vectorFilesIn(t, directory) {
		if _, old := before[path]; !old {
			return true
		}
	}
	return false
}

func TestACheckpointRemovesAReplacedVectorFileOnceAnOutsideReaderClosesIt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	narsil, err := heldGarbageEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	config := engine.IndexConfig{
		Schema: engine.Schema{"embedding": engine.VectorFieldType(vectorSettingsDimension)},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(documentsPastPromotion),
			Storage: engine.VectorStorageDisk},
	}
	if err := narsil.CreateIndex(ctx, heldGarbageIndex, config); err != nil {
		t.Fatalf("creating the index failed: %v", err)
	}
	documents := make([]*engine.Document, documentsBelowPromotion)
	updates := make([]engine.DocumentUpdate, documentsBelowPromotion)
	for position := range documents {
		id := fmt.Sprintf("item-%d", position)
		documents[position] = engine.NewDocument().Set("id", id).Set("embedding", catalogueVector(position))
		updates[position] = engine.DocumentUpdate{DocID: id,
			Document: engine.NewDocument().Set("embedding", sameDirectionScaled(catalogueVector(position), heldGarbageScale))}
	}
	if result, err := narsil.InsertBatch(ctx, heldGarbageIndex, documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("inserting the vectors failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, heldGarbageIndex, "embedding"); err != nil {
		t.Fatal(err)
	}
	if err := narsil.Checkpoint(ctx, heldGarbageIndex); err != nil {
		t.Fatal(err)
	}
	before := vectorFilesIn(t, directory)
	if result, err := narsil.UpdateBatch(ctx, heldGarbageIndex, updates, engine.WriteOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("rewriting every vector failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, heldGarbageIndex, "embedding"); err != nil {
		t.Fatal(err)
	}
	readers := make([]*os.File, 0, len(before))
	for path := range before {
		reader, err := os.Open(path)
		if err != nil {
			t.Fatalf("opening %s as an outside reader failed: %v", path, err)
		}
		readers = append(readers, reader)
	}
	saved := make(chan error, 1)
	go func() { saved <- narsil.Checkpoint(ctx, heldGarbageIndex) }()
	written, finishedWhileHeld := false, false
	var checkpointErr error
	deadline := time.Now().Add(heldGarbageDeadline)
	for !written && !finishedWhileHeld && time.Now().Before(deadline) {
		select {
		case checkpointErr = <-saved:
			finishedWhileHeld = true
		default:
			written = newVectorFileWritten(t, directory, before)
			time.Sleep(heldGarbagePoll)
		}
	}
	for _, reader := range readers {
		if err := reader.Close(); err != nil {
			t.Fatalf("closing the outside reader failed: %v", err)
		}
	}
	if !finishedWhileHeld {
		checkpointErr = <-saved
	}
	if checkpointErr != nil {
		t.Fatalf("the checkpoint failed while an outside reader held a replaced vector file, with %s: %v",
			codeOrMessage(checkpointErr), checkpointErr)
	}
	if finishedWhileHeld && runtime.GOOS == "windows" {
		t.Fatal("the checkpoint finished before it wrote the new vector file, so the outside reader held nothing it removed")
	}
	after := vectorFilesIn(t, directory)
	for path := range before {
		if _, left := after[path]; left {
			t.Fatalf("%s holds only replaced vectors, yet it stayed on disk after the outside reader closed it", path)
		}
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down: %v", err)
	}
	reopened, err := heldGarbageEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused to reopen the directory: %v", err)
	}
	defer shutDown(t, reopened, "after the reopen")
	query := catalogueVector(nearestNeighboursChecked)
	result, err := reopened.Query(ctx, heldGarbageIndex, engine.QueryParams{Mode: engine.SearchVector,
		Limit: engine.Some(1), IncludeScores: true, Vector: &engine.VectorQueryConfig{Field: "embedding", Value: query}})
	if err != nil {
		t.Fatalf("searching after the reopen failed: %v", err)
	}
	expected := cosineOracle(query, documentsBelowPromotion)
	if len(result.Hits) != 1 || result.Hits[0].ID != expected[0].id {
		t.Fatalf("the nearest vector after the reopen is %+v, expected %s", result.Hits, expected[0].id)
	}
}
