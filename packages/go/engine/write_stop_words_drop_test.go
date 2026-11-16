package engine_test

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestAWriteStopWordFunctionCanDropItsIndex(t *testing.T) {
	ctx := context.Background()
	var armed atomic.Bool
	var narsil *engine.Narsil
	var nested error
	stops := engine.StopWordsFromFunction(func(words engine.StopWordSet) engine.StopWordSet {
		if armed.Swap(false) {
			nested = narsil.DropIndex(ctx, callbackIndex)
		}
		return words
	})
	var err error
	narsil, err = engine.New(ctx, engine.Config{
		Workers:      engine.WorkerConfig{Enabled: engine.Some(false)},
		StopWordSets: map[string]engine.StopWords{"dropping": stops},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after the stop word drop")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}, StopWords: engine.NamedStopWords("dropping"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "harbour"), "kept",
		engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	armed.Store(true)
	err = narsil.Update(ctx, callbackIndex, "kept", engine.NewDocument().Set("title", "pier"), engine.WriteOptions{})
	if nested != nil || engine.ErrorCode(err) != engine.CodeIndexNotFound {
		t.Fatalf("the drop returned %v and the update returned %v", nested, err)
	}
}
