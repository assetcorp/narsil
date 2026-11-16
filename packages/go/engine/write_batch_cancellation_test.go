package engine_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type cancelledBatchKind string

const (
	cancelledInsertBatch cancelledBatchKind = "insert"
	cancelledUpdateBatch cancelledBatchKind = "update"
	cancelledRemoveBatch cancelledBatchKind = "remove"
	cancelledBatchSize                      = 1_000
	seededTitleWord                         = "harbour"
	updatedTitleWord                        = "pier"
)

func TestACancelledBatchKeepsItsVisibleDocumentsAfterRestart(t *testing.T) {
	for _, kind := range []cancelledBatchKind{cancelledInsertBatch, cancelledUpdateBatch, cancelledRemoveBatch} {
		t.Run(string(kind), func(t *testing.T) {
			cancelBatchAfterPublication(t, kind)
		})
	}
}

func cancelledBatchDocuments(word string) ([]*engine.Document, []string) {
	documents := make([]*engine.Document, cancelledBatchSize)
	ids := make([]string, len(documents))
	for at := range documents {
		ids[at] = fmt.Sprintf("item-%d", at)
		documents[at] = engine.NewDocument().Set("id", ids[at]).Set("title", strings.Repeat(word+" lighthouse ", 1_000))
	}
	return documents, ids
}

func cancelBatchAfterPublication(t *testing.T, kind cancelledBatchKind) {
	t.Helper()
	ctx := context.Background()
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}}
	narsil, err := engine.New(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after cancelling the batch")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString},
	}); err != nil {
		t.Fatal(err)
	}
	documents, ids := cancelledBatchDocuments(seededTitleWord)
	if kind != cancelledInsertBatch {
		result, err := narsil.InsertBatch(ctx, callbackIndex, documents, engine.InsertOptions{})
		if err != nil || len(result.Succeeded) != len(documents) {
			t.Fatalf("seeding the documents failed: %+v, %v", result, err)
		}
	}
	outcome := runCancelledBatch(t, narsil, kind, documents, ids)
	requireEachDocumentReportedOnce(t, outcome, ids)
	failed := make([]string, 0, len(outcome.Failed))
	for _, failure := range outcome.Failed {
		failed = append(failed, failure.DocID)
	}
	visible := map[string][]string{}
	switch kind {
	case cancelledInsertBatch:
		visible[seededTitleWord] = outcome.Succeeded
	case cancelledUpdateBatch:
		visible[seededTitleWord], visible[updatedTitleWord] = failed, outcome.Succeeded
	case cancelledRemoveBatch:
		visible[seededTitleWord] = failed
	}
	requireCancelledBatchDocuments(t, narsil, visible)
	shutDownWithin(t, narsil, "before reopening the cancelled batch")
	reopened, err := engine.New(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, reopened, "after reopening the cancelled batch")
	requireCancelledBatchDocuments(t, reopened, visible)
}

func runCancelledBatch(t *testing.T, narsil *engine.Narsil, kind cancelledBatchKind, documents []*engine.Document,
	ids []string) engine.BatchResult {
	t.Helper()
	ctx := context.Background()
	bounded, cancel := context.WithCancel(ctx)
	defer cancel()
	updated, _ := cancelledBatchDocuments(updatedTitleWord)
	written := make(chan error, 1)
	var outcome engine.BatchResult
	go func() {
		var err error
		switch kind {
		case cancelledInsertBatch:
			outcome, err = narsil.InsertBatch(bounded, callbackIndex, documents, engine.InsertOptions{})
		case cancelledUpdateBatch:
			updates := make([]engine.DocumentUpdate, len(ids))
			for at, id := range ids {
				updates[at] = engine.DocumentUpdate{DocID: id, Document: updated[at]}
			}
			outcome, err = narsil.UpdateBatch(bounded, callbackIndex, updates, engine.WriteOptions{})
		case cancelledRemoveBatch:
			outcome, err = narsil.RemoveBatch(bounded, callbackIndex, ids, engine.WriteOptions{})
		}
		written <- err
	}()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(callbackDeadline)
	defer deadline.Stop()
	for !batchPublished(t, narsil, kind) {
		select {
		case err := <-written:
			t.Fatalf("the batch ended before cancellation: %v", err)
		case <-deadline.C:
			t.Fatal("the batch published no documents before the deadline")
		case <-ticker.C:
		}
	}
	cancel()
	if err := <-written; !errors.Is(err, context.Canceled) {
		t.Fatalf("the cancelled batch returned %v", err)
	}
	if len(outcome.Succeeded) == 0 || len(outcome.Failed) == 0 {
		t.Fatalf("the cancelled batch did not report its applied prefix and refused remainder: %+v", outcome)
	}
	return outcome
}

func batchPublished(t *testing.T, narsil *engine.Narsil, kind cancelledBatchKind) bool {
	t.Helper()
	ctx := context.Background()
	if kind == cancelledUpdateBatch {
		result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: updatedTitleWord})
		if err != nil {
			t.Fatal(err)
		}
		return result.Count > 0
	}
	count, err := narsil.CountDocuments(ctx, callbackIndex)
	if err != nil {
		t.Fatal(err)
	}
	return kind == cancelledInsertBatch && count > 0 || kind == cancelledRemoveBatch && count < cancelledBatchSize
}

func requireEachDocumentReportedOnce(t *testing.T, outcome engine.BatchResult, ids []string) {
	t.Helper()
	reported := map[string]int{}
	for _, id := range outcome.Succeeded {
		reported[id]++
	}
	for _, failure := range outcome.Failed {
		reported[failure.DocID]++
	}
	for _, id := range ids {
		if reported[id] != 1 {
			t.Fatalf("the cancelled batch reported %s %d times across %d succeeded and %d failed", id, reported[id],
				len(outcome.Succeeded), len(outcome.Failed))
		}
	}
	if len(reported) != len(ids) {
		t.Fatalf("the cancelled batch reported %d distinct documents for %d sent", len(reported), len(ids))
	}
}

func requireCancelledBatchDocuments(t *testing.T, narsil *engine.Narsil, visible map[string][]string) {
	t.Helper()
	for _, word := range []string{seededTitleWord, updatedTitleWord} {
		expected := slices.Clone(visible[word])
		slices.Sort(expected)
		result, err := narsil.Query(context.Background(), callbackIndex, engine.QueryParams{Term: word,
			Limit: engine.Some(cancelledBatchSize)})
		if err != nil {
			t.Fatal(err)
		}
		found := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			found = append(found, hit.ID)
		}
		slices.Sort(found)
		if result.Count != len(expected) || !slices.Equal(found, expected) {
			t.Fatalf("searching %q returned %d documents, while the batch outcome requires %d", word, len(found),
				len(expected))
		}
	}
}
