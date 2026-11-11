package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	hitVectorsDocumentID = "carried"
	hitVectorsReaders    = 16
)

var hitVector = []float32{0.5, -1, 2, 0.25}

func hitWithVector(t *testing.T, narsil *engine.Narsil) *engine.Document {
	t.Helper()
	result, err := narsil.Query(context.Background(), documentOrderIndex, engine.QueryParams{Term: "shared"})
	if err != nil || len(result.Hits) != 1 {
		t.Fatalf("the query returned %d hits with %s: %v", len(result.Hits), codeOrMessage(err), err)
	}
	return result.Hits[0].Document
}

func requireStoredVector(t *testing.T, narsil *engine.Narsil, body string) {
	t.Helper()
	stored, found, err := narsil.Get(context.Background(), documentOrderIndex, hitVectorsDocumentID)
	if err != nil || !found {
		t.Fatalf("the engine failed to read the document (found %t) with %s: %v", found, codeOrMessage(err), err)
	}
	expected := map[string]any{"id": hitVectorsDocumentID, "body": body, "meta": map[string]any{"tier": "gold"},
		"embedding": hitVector}
	if found := stored.Map(); !reflect.DeepEqual(found, expected) {
		t.Fatalf("the stored document reads as %v, while the update wrote %v", found, expected)
	}
}

func TestAHitKeepsItsVectorThroughConcurrentReadsJSONAndUpdates(t *testing.T) {
	ctx := context.Background()
	narsil := startedInMemory(t)
	if err := narsil.CreateIndex(ctx, documentOrderIndex, engine.IndexConfig{Language: "english", Schema: engine.Schema{
		"body": engine.FieldString, "embedding": engine.VectorFieldType(len(hitVector))}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	written := engine.NewDocument().Set("id", hitVectorsDocumentID).Set("body", "shared words").
		Set("meta", engine.NewDocument().Set("tier", "gold")).Set("embedding", append([]float32{}, hitVector...))
	if _, err := narsil.Insert(ctx, documentOrderIndex, written, "", engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
	}
	hit := hitWithVector(t, narsil)
	failures := make(chan string, hitVectorsReaders)
	var readers sync.WaitGroup
	for reader := range hitVectorsReaders {
		readers.Add(1)
		go func() {
			defer readers.Done()
			if reader%2 == 0 {
				if value, held := hit.Get("embedding"); !held || !reflect.DeepEqual(value, hitVector) {
					failures <- fmt.Sprintf("Get(\"embedding\") returned %v (held %t)", value, held)
				}
				return
			}
			if found := hit.Map()["embedding"]; !reflect.DeepEqual(found, hitVector) {
				failures <- fmt.Sprintf("Map holds the vector %v", found)
			}
		}()
	}
	readers.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	if value, isVector := hit.Map()["embedding"].([]float32); isVector {
		value[0] = 99
	}
	if value, isVector := hit.Get("embedding"); isVector {
		value.([]float32)[1] = 99
	}
	if value, _ := hit.Get("embedding"); !reflect.DeepEqual(value, hitVector) {
		t.Fatalf("a change to a vector that Get and Map returned reached the hit, which now holds %v", value)
	}
	encoded, err := json.Marshal(hit)
	if err != nil || !strings.Contains(string(encoded), `"embedding":[0.5,-1,2,0.25]`) {
		t.Fatalf("json.Marshal of the hit wrote %s (%v), while the hit carries the vector %v", encoded, err, hitVector)
	}
	if err := narsil.Update(ctx, documentOrderIndex, hitVectorsDocumentID, hitWithVector(t, narsil), engine.WriteOptions{}); err != nil {
		t.Fatalf("the engine refused the unchanged hit with %s: %v", codeOrMessage(err), err)
	}
	requireStoredVector(t, narsil, "shared words")
	changed := hitWithVector(t, narsil).Set("body", "shared later")
	if err := narsil.Update(ctx, documentOrderIndex, hitVectorsDocumentID, changed, engine.WriteOptions{}); err != nil {
		t.Fatalf("the engine refused the changed hit with %s: %v", codeOrMessage(err), err)
	}
	requireStoredVector(t, narsil, "shared later")
}
