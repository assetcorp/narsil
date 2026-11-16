package engine_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	searchCallbackIndex      = "harbour-notes"
	searchCallbackDocuments  = 40
	searchCallbackRevisedID  = "note-1"
	searchCallbackTerm       = "pier"
	searchCallbackRevision   = "pier note revised"
	searchCallbackWait       = 20 * time.Second
	searchCallbackWriteLimit = 10 * time.Second
)

type searchCallbackOutcome struct {
	called bool
	err    error
}

func searchCallbackTitle(position int) string {
	if position%2 == 0 {
		return fmt.Sprintf("pier note %d", position)
	}
	return fmt.Sprintf("dock note %d", position)
}

func searchCallbackMatches(revised bool) []string {
	matches := []string{}
	for position := range searchCallbackDocuments {
		id := fmt.Sprintf("note-%d", position)
		if position%2 == 0 || revised && id == searchCallbackRevisedID {
			matches = append(matches, id)
		}
	}
	slices.Sort(matches)
	return matches
}

func TestASearchFinishesWhenItsContextCallbackUpdatesAndCheckpoints(t *testing.T) {
	for at := int64(1); ; at++ {
		directory := t.TempDir()
		outcome := make(chan searchCallbackOutcome, 1)
		go func() { outcome <- searchWithAWritingCallback(directory, at) }()
		select {
		case finished := <-outcome:
			if finished.err != nil {
				t.Fatalf("with the callback on context check %d, %v", at, finished.err)
			}
			if !finished.called {
				return
			}
		case <-time.After(searchCallbackWait):
			t.Fatalf("the search never returned once its context callback on check %d updated a document and checkpointed", at)
		}
	}
}

func searchWithAWritingCallback(directory string, at int64) searchCallbackOutcome {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		return searchCallbackOutcome{err: err}
	}
	outcome := searchThroughAWritingCallback(ctx, narsil, at)
	if err := narsil.Shutdown(ctx); err != nil && outcome.err == nil {
		outcome.err = fmt.Errorf("the engine failed to shut down: %w", err)
	}
	return outcome
}

func searchThroughAWritingCallback(ctx context.Context, narsil *engine.Narsil, at int64) searchCallbackOutcome {
	if err := narsil.CreateIndex(ctx, searchCallbackIndex,
		engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		return searchCallbackOutcome{err: err}
	}
	documents := make([]*engine.Document, searchCallbackDocuments)
	for position := range documents {
		documents[position] = engine.DocumentFromMap(map[string]any{"id": fmt.Sprintf("note-%d", position),
			"title": searchCallbackTitle(position)})
	}
	inserted, err := narsil.InsertBatch(ctx, searchCallbackIndex, documents, engine.InsertOptions{})
	if err != nil || len(inserted.Failed) > 0 {
		return searchCallbackOutcome{err: fmt.Errorf("inserting the notes failed: %v %+v", err, inserted.Failed)}
	}
	var callbackErr error
	called := false
	callback := &checkpointContext{Context: ctx, at: at, act: func() {
		called = true
		bounded, cancel := context.WithTimeout(ctx, searchCallbackWriteLimit)
		defer cancel()
		callbackErr = narsil.Update(bounded, searchCallbackIndex, searchCallbackRevisedID,
			engine.NewDocument().Set("title", searchCallbackRevision), engine.WriteOptions{})
		if callbackErr == nil {
			callbackErr = narsil.Checkpoint(bounded, searchCallbackIndex)
		}
	}}
	result, err := narsil.Query(callback, searchCallbackIndex,
		engine.QueryParams{Term: searchCallbackTerm, Limit: engine.Some(searchCallbackDocuments)})
	if callbackErr != nil {
		return searchCallbackOutcome{called: called, err: fmt.Errorf("the update and checkpoint in the callback failed: %w", callbackErr)}
	}
	if err != nil {
		return searchCallbackOutcome{called: called, err: fmt.Errorf("the search failed: %w", err)}
	}
	found := make([]string, 0, len(result.Hits))
	for _, hit := range result.Hits {
		found = append(found, hit.ID)
	}
	slices.Sort(found)
	if !slices.Equal(found, searchCallbackMatches(false)) && !slices.Equal(found, searchCallbackMatches(called)) {
		return searchCallbackOutcome{called: called, err: fmt.Errorf("the search found %v", found)}
	}
	if called {
		stored, held, err := narsil.Get(ctx, searchCallbackIndex, searchCallbackRevisedID)
		if err != nil || !held {
			return searchCallbackOutcome{called: called, err: fmt.Errorf("the updated note is missing: %v", err)}
		}
		if title, _ := stored.Get("title"); title != searchCallbackRevision {
			return searchCallbackOutcome{called: called, err: fmt.Errorf("the updated note holds %v", title)}
		}
	}
	return searchCallbackOutcome{called: called}
}
