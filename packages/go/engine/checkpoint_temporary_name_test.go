package engine_test

import (
	"context"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestRecoveryKeepsAnIndexWhoseNameContainsTheTemporaryFileMarker(t *testing.T) {
	ctx := context.Background()
	const name = "catalogue.tmp-copy"
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync}}
	narsil, err := engine.New(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if err := narsil.CreateIndex(ctx, name, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, name, engine.NewDocument().Set("title", "harbour"), "kept", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := narsil.Checkpoint(ctx, name); err != nil {
		t.Fatal(err)
	}
	shutDownWithin(t, narsil, "before reopening the temporary-looking name")
	for range 2 {
		narsil, err = engine.New(ctx, config)
		if err != nil {
			t.Fatal(err)
		}
		result, queryErr := narsil.Query(ctx, name, engine.QueryParams{Term: "harbour"})
		shutDownWithin(t, narsil, "after reopening the temporary-looking name")
		if queryErr != nil || result.Count != 1 || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
			t.Fatalf("recovery lost the acknowledged document: %+v, %v", result, queryErr)
		}
	}
}
