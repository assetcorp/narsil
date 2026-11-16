package engine_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestADiskCheckpointStopWordFunctionCanCheckpoint(t *testing.T) {
	ctx := context.Background()
	var armed atomic.Bool
	var narsil *engine.Narsil
	var nested error
	stops := engine.StopWordsFromFunction(func(words engine.StopWordSet) engine.StopWordSet {
		if armed.Swap(false) {
			bounded, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			nested = narsil.Checkpoint(bounded, callbackIndex)
		}
		return words
	})
	var err error
	narsil, err = engine.New(ctx, engine.Config{
		Workers:      engine.WorkerConfig{Enabled: engine.Some(false)},
		StopWordSets: map[string]engine.StopWords{"callback": stops},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after the stop word callback")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}, TextStorage: engine.TextStorageDisk,
		StopWords: engine.NamedStopWords("callback"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "harbour"), "kept",
		engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	armed.Store(true)
	if err := narsil.Checkpoint(ctx, callbackIndex); err != nil {
		t.Fatal(err)
	}
	if armed.Load() {
		t.Fatal("the checkpoint never called the stop word function")
	}
	if nested != nil {
		t.Fatalf("the checkpoint inside the stop word function failed: %v", nested)
	}
	result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "harbour"})
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
		t.Fatalf("the checkpoint changed the searchable document: %+v, %v", result, err)
	}
}

func TestAStopWordFunctionCanWriteDuringADurableAnalysisSwitch(t *testing.T) {
	ctx := context.Background()
	var inside atomic.Bool
	var calls atomic.Int64
	var narsil *engine.Narsil
	nested := &nestedErrors{}
	stops := engine.StopWordsFromFunction(func(words engine.StopWordSet) engine.StopWordSet {
		if inside.CompareAndSwap(false, true) {
			calls.Add(1)
			nested.note(narsil.Update(ctx, callbackIndex, "kept",
				engine.NewDocument().Set("title", "harbour noise"), engine.WriteOptions{}))
			inside.Store(false)
		}
		return engine.NewStopWordSet("noise")
	})
	var err error
	narsil, err = engine.New(ctx, engine.Config{
		Workers:      engine.WorkerConfig{Enabled: engine.Some(false)},
		StopWordSets: map[string]engine.StopWords{"writing": stops},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after the analysis callback")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}, TextStorage: engine.TextStorageDisk,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "pier"), "kept",
		engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := finishedWithin(t, "the switch whose stop word function writes", func() (struct{}, error) {
		return struct{}{}, narsil.ChangeAnalysis(ctx, callbackIndex,
			engine.AnalysisChange{StopWords: engine.ChangeToRegisteredStopWords("writing")})
	}); err != nil {
		t.Fatal(err)
	}
	inside.Store(true)
	if calls.Load() == 0 || nested.first() != nil {
		t.Fatalf("the stop word function made %d writes, with error %v", calls.Load(), nested.first())
	}
	for term, count := range map[string]int{"harbour": 1, "pier": 0, "noise": 0} {
		result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: term})
		if err != nil || result.Count != count {
			t.Fatalf("searching for %q returned %d documents, expected %d: %v", term, result.Count, count, err)
		}
	}
}
