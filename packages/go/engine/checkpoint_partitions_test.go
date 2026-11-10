package engine_test

import (
	"bytes"
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	spreadSaveIndex             = "parcels"
	spreadSavePartitions        = 4
	spreadSaveDocsPerPartition  = 100
	spreadSaveDocuments         = 400
	spreadSaveMinimumPartitions = 3
	spreadSaveDeadline          = time.Minute
)

func spreadSaveTitle(number int) string {
	return "parcel number " + strconv.Itoa(number)
}

func fillSpreadIndex(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, spreadSaveIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Language: "english", Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(spreadSavePartitions),
			MaxDocsPerPartition: engine.Some(spreadSaveDocsPerPartition)}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	documents := make([]*engine.Document, 0, spreadSaveDocuments)
	for number := range spreadSaveDocuments {
		documents = append(documents, engine.DocumentFromMap(map[string]any{"id": "parcel-" + strconv.Itoa(number),
			"title": spreadSaveTitle(number)}))
	}
	insertEvery(t, narsil, spreadSaveIndex, documents)
	segments, err := engine.SearchedSegmentsOf(ctx, narsil, spreadSaveIndex)
	if err != nil || len(segments) < spreadSaveMinimumPartitions {
		t.Fatalf("the index spans %d partitions with error %v, while the case needs at least %d", len(segments), err,
			spreadSaveMinimumPartitions)
	}
}

func finishWithin(t *testing.T, action string, work func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- work() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("the %s failed with %s: %v", action, codeOrMessage(err), err)
		}
	case <-time.After(spreadSaveDeadline):
		t.Fatalf("the %s of an index spread over several partitions had not returned after %v", action,
			spreadSaveDeadline)
	}
}

func requireEverySpreadDocument(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	for number := range spreadSaveDocuments {
		id := "parcel-" + strconv.Itoa(number)
		stored, found, err := narsil.Get(context.Background(), spreadSaveIndex, id)
		if err != nil || !found {
			t.Fatalf("%s is missing: found %v, error %v", id, found, err)
		}
		if title := stored.Map()["title"]; title != spreadSaveTitle(number) {
			t.Fatalf("%s holds %q, while it was written as %q", id, title, spreadSaveTitle(number))
		}
	}
}

func TestSavesOfAnIndexSpreadOverSeveralPartitionsFinishAndKeepEveryDocument(t *testing.T) {
	t.Run("a snapshot of an index held in memory", func(t *testing.T) {
		t.Parallel()
		narsil := openPlainEngine(t, engine.Config{})
		fillSpreadIndex(t, narsil)
		var archive bytes.Buffer
		finishWithin(t, "snapshot", func() error {
			return narsil.Snapshot(context.Background(), spreadSaveIndex, engine.SnapshotOptions{}, &archive)
		})
		restored := openPlainEngine(t, engine.Config{})
		if err := restored.Restore(context.Background(), spreadSaveIndex, &archive); err != nil {
			t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
		}
		requireEverySpreadDocument(t, restored)
	})
	t.Run("a shutdown of a durable index", func(t *testing.T) {
		t.Parallel()
		directory := t.TempDir()
		narsil := openBusyCheckpointEngine(t, directory)
		fillSpreadIndex(t, narsil)
		finishWithin(t, "shutdown", func() error { return narsil.Shutdown(context.Background()) })
		reopened := openBusyCheckpointEngine(t, directory)
		defer func() { _ = reopened.Shutdown(context.Background()) }()
		requireEverySpreadDocument(t, reopened)
	})
}
