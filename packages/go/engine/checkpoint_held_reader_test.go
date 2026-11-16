package engine_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	heldReaderIndex        = "ledgers"
	heldReaderDocuments    = 200
	heldReaderPoll         = time.Millisecond
	heldReaderDeadline     = time.Minute
	heldReaderStagedMarker = ".tmp-"
)

func heldReaderEngine(ctx context.Context, directory string) (*engine.Narsil, error) {
	return engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}})
}

func heldReaderTitle(number int) string {
	return "ledger entry " + strconv.Itoa(number)
}

func stagedMetaWaiting(indexDirectory string) bool {
	entries, err := os.ReadDir(indexDirectory)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "meta"+heldReaderStagedMarker) {
			return true
		}
	}
	return false
}

func TestACheckpointSavesOnceAnOutsideReaderClosesTheMetaFileItHeldOpen(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	narsil, err := heldReaderEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	schema := engine.Schema{"title": engine.FieldString}
	if err := narsil.CreateIndex(ctx, heldReaderIndex, engine.IndexConfig{Schema: schema}); err != nil {
		t.Fatalf("creating the index failed: %v", err)
	}
	batch := make([]*engine.Document, 0, heldReaderDocuments)
	for number := range heldReaderDocuments {
		batch = append(batch, engine.NewDocument().Set("id", "entry-"+strconv.Itoa(number)).Set("title", heldReaderTitle(number)))
	}
	if result, err := narsil.InsertBatch(ctx, heldReaderIndex, batch, engine.InsertOptions{}); err != nil || len(result.Failed) > 0 {
		t.Fatalf("inserting the entries failed: %v %v", err, result.Failed)
	}
	indexDirectory := filepath.Join(directory, heldReaderIndex)
	metaPath := filepath.Join(indexDirectory, "meta")
	before, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("the index wrote no meta file: %v", err)
	}
	reader, err := os.Open(metaPath)
	if err != nil {
		t.Fatalf("opening the meta file as an outside reader failed: %v", err)
	}
	saved := make(chan error, 1)
	go func() { saved <- narsil.Checkpoint(ctx, heldReaderIndex) }()
	waited, finishedWhileHeld := false, false
	var checkpointErr error
	deadline := time.Now().Add(heldReaderDeadline)
	for !waited && !finishedWhileHeld && time.Now().Before(deadline) {
		select {
		case checkpointErr = <-saved:
			finishedWhileHeld = true
		default:
			waited = stagedMetaWaiting(indexDirectory)
			time.Sleep(heldReaderPoll)
		}
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("closing the outside reader failed: %v", err)
	}
	if finishedWhileHeld && runtime.GOOS == "windows" {
		t.Fatalf("the checkpoint finished while an outside reader held the meta file, so it never replaced that file: %v",
			checkpointErr)
	}
	if !finishedWhileHeld {
		checkpointErr = <-saved
	}
	if checkpointErr != nil {
		t.Fatalf("the checkpoint failed after the outside reader closed the meta file, with %s: %v",
			codeOrMessage(checkpointErr), checkpointErr)
	}
	after, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("the meta file is unreadable after the checkpoint: %v", err)
	}
	if bytes.Equal(before, after) {
		t.Fatal("the checkpoint left the meta file as it was before the entries arrived")
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down: %v", err)
	}
	reopened, err := heldReaderEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused to reopen the directory: %v", err)
	}
	defer func() {
		if err := reopened.Shutdown(ctx); err != nil {
			t.Fatalf("the reopened engine failed to shut down: %v", err)
		}
	}()
	for number := range heldReaderDocuments {
		document, found, err := reopened.Get(ctx, heldReaderIndex, "entry-"+strconv.Itoa(number))
		if err != nil || !found {
			t.Fatalf("entry %d is missing after the restart: %v", number, err)
		}
		if title, _ := document.Get("title"); title != heldReaderTitle(number) {
			t.Fatalf("entry %d came back titled %v, where it was saved as %q", number, title, heldReaderTitle(number))
		}
	}
}
