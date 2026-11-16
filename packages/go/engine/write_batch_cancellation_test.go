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

func TestACancelledBatchKeepsItsVisibleDocumentsAfterRestart(t *testing.T) {
	for _, removing := range []bool{false, true} {
		t.Run(fmt.Sprintf("removing=%t", removing), func(t *testing.T) {
			cancelBatchAfterPublication(t, removing)
		})
	}
}

func cancelBatchAfterPublication(t *testing.T, removing bool) {
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
	documents := make([]*engine.Document, 1_000)
	ids := make([]string, len(documents))
	for at := range documents {
		ids[at] = fmt.Sprintf("item-%d", at)
		documents[at] = engine.NewDocument().Set("id", ids[at]).
			Set("title", strings.Repeat("harbour lighthouse ", 1_000))
	}
	if removing {
		result, err := narsil.InsertBatch(ctx, callbackIndex, documents, engine.InsertOptions{})
		if err != nil || len(result.Succeeded) != len(documents) {
			t.Fatalf("seeding the documents failed: %+v, %v", result, err)
		}
	}
	bounded, cancel := context.WithCancel(ctx)
	defer cancel()
	written := make(chan error, 1)
	var outcome engine.BatchResult
	go func() {
		var err error
		if removing {
			outcome, err = narsil.RemoveBatch(bounded, callbackIndex, ids, engine.WriteOptions{})
		} else {
			outcome, err = narsil.InsertBatch(bounded, callbackIndex, documents, engine.InsertOptions{})
		}
		written <- err
	}()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(callbackDeadline)
	defer deadline.Stop()
	for {
		select {
		case err := <-written:
			t.Fatalf("the batch ended before cancellation: %v", err)
		case <-deadline.C:
			t.Fatal("the batch published no documents before the deadline")
		case <-ticker.C:
		}
		count, err := narsil.CountDocuments(ctx, callbackIndex)
		if err != nil {
			t.Fatal(err)
		}
		if !removing && count > 0 || removing && count < len(documents) {
			cancel()
			break
		}
	}
	if err := <-written; !errors.Is(err, context.Canceled) {
		t.Fatalf("the cancelled batch returned %v", err)
	}
	if len(outcome.Succeeded) == 0 || len(outcome.Failed) == 0 ||
		len(outcome.Succeeded)+len(outcome.Failed) != len(documents) {
		t.Fatalf("the cancelled batch did not report its applied prefix and refused remainder: %+v", outcome)
	}
	expected := slices.Clone(outcome.Succeeded)
	if removing {
		expected = nil
		for _, failure := range outcome.Failed {
			expected = append(expected, failure.DocID)
		}
	}
	slices.Sort(expected)
	requireCancelledBatchDocuments(t, narsil, expected, len(documents))
	shutDownWithin(t, narsil, "before reopening the cancelled batch")
	reopened, err := engine.New(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, reopened, "after reopening the cancelled batch")
	requireCancelledBatchDocuments(t, reopened, expected, len(documents))
}

func requireCancelledBatchDocuments(t *testing.T, narsil *engine.Narsil, expected []string, limit int) {
	t.Helper()
	result, err := narsil.Query(context.Background(), callbackIndex, engine.QueryParams{Term: "harbour",
		Limit: engine.Some(limit)})
	if err != nil {
		t.Fatal(err)
	}
	found := make([]string, 0, len(result.Hits))
	for _, hit := range result.Hits {
		found = append(found, hit.ID)
	}
	slices.Sort(found)
	if result.Count != len(expected) || !slices.Equal(found, expected) {
		t.Fatalf("the search returned %v, while the batch outcome requires %v", found, expected)
	}
}
