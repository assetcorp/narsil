package engine_test

import (
	"context"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestReopenedNullVectorsRespectProjectionForNumericMapKeys(t *testing.T) {
	for _, key := range []struct {
		name        string
		field       string
		original    string
		replacement string
	}{
		{"numeric NaN", "NaN", "a87265736572766564", "cb7ff8000000000000"},
		{"numeric infinity", "Infinity", "a87265736572766564", "cb7ff0000000000000"},
	} {
		t.Run(key.name, func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			config := engine.Config{Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}}
			writer := vectorReadEngine(t, config)
			const name = "encoded-null"
			if err := writer.CreateIndex(ctx, name, engine.IndexConfig{Language: "english", Schema: engine.Schema{
				"title": engine.FieldString, key.field: engine.VectorFieldType(4),
			}}); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Insert(ctx, name, engine.NewDocument().Set("title", "shared").Set("reserved", nil),
				"record", engine.InsertOptions{}); err != nil {
				t.Fatal(err)
			}
			if err := writer.Checkpoint(ctx, name); err != nil {
				t.Fatal(err)
			}
			if err := writer.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			runTamperScript(t, "directory", directory, name, key.original, key.replacement, "hex")
			reader := vectorReadEngine(t, config)
			shown, found, err := reader.Get(ctx, name, "record", engine.ReturnVectors(true))
			if err != nil || !found {
				t.Fatalf("Get with vectors found %t: %v", found, err)
			}
			if value, held := shown.Get(key.field); !held || value != nil {
				t.Fatalf("Get with vectors returned %v", shown.Map())
			}
			projection := engine.ExcludeFields("__proto__")
			queried, err := reader.Query(ctx, name, engine.QueryParams{Term: "shared", Document: projection})
			if err != nil || len(queried.Hits) != 1 {
				t.Fatalf("Query returned %d hits: %v", len(queried.Hits), err)
			}
			if value, held := queried.Hits[0].Document.Get(key.field); held {
				t.Fatalf("Query returned the hidden vector field %q: %v", key.field, value)
			}
			hidden, found, err := reader.Get(ctx, name, "record", projection)
			if err != nil || !found {
				t.Fatalf("Get found %t: %v", found, err)
			}
			if value, held := hidden.Get(key.field); held {
				t.Fatalf("Get returned the hidden vector field %q: %v", key.field, value)
			}
		})
	}
}
