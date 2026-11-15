package engine_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestSearchesAndCheckpointsBesideATokenizingRemove(t *testing.T) {
	ctx := context.Background()
	tokenizer := &reenteringTokenizer{}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
		Tokenizers: map[string]engine.Tokenizer{"callback": tokenizer}})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDown(t, narsil, "after the blocked writer")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}, Tokenizer: engine.NamedTokenizer("callback"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "removed", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	entered, proceed := make(chan struct{}), make(chan struct{})
	tokenizer.act = func() { close(entered); <-proceed }
	tokenizer.armed.Store(true)
	written := make(chan error, 1)
	go func() { written <- narsil.Remove(ctx, callbackIndex, "removed", engine.WriteOptions{}) }()
	<-entered
	bounded, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	searched := make(chan error, 1)
	checkpointed := make(chan error, 1)
	go func() { checkpointed <- narsil.Checkpoint(bounded, callbackIndex) }()
	found := make(chan int, 1)
	go func() {
		result, err := narsil.Query(bounded, callbackIndex, engine.QueryParams{Term: "lighthouse"})
		found <- result.Count
		searched <- err
	}()
	var searchErr error
	returned := false
	select {
	case searchErr = <-searched:
		returned = true
	case <-time.After(time.Second):
	}
	checkpointReturned := false
	var checkpointErr error
	select {
	case checkpointErr = <-checkpointed:
		checkpointReturned = true
	case <-time.After(time.Second):
	}
	close(proceed)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if !returned {
		<-searched
		t.Fatal("the search waited for the remove whose tokenizer was running")
	}
	if count := <-found; searchErr != nil || count != 1 {
		t.Fatalf("the search beside the remove found %d documents with error %v; the index held 1", count, searchErr)
	}
	if !checkpointReturned {
		<-checkpointed
		t.Fatal("the checkpoint waited beyond its deadline for the writer")
	}
	if !errors.Is(checkpointErr, context.DeadlineExceeded) {
		t.Fatalf("the checkpoint returned %v", checkpointErr)
	}
	result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "lighthouse"})
	if err != nil || result.Count != 0 {
		t.Fatalf("the removed document remains searchable: %+v, %v", result, err)
	}
}
