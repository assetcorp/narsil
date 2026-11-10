package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	documentOrderIndex      = "ordered"
	documentOrderGroupField = "meta"
	documentOrderUpdateNote = "second"
	heldDocumentCount       = 1500
	heldDocumentsRemoved    = 1200
	heldHitLimit            = 200
	heldCompactionThreshold = 2
	firstReadGoroutines     = 16
	firstReadKeyCount       = 40
)

type keyOrderGroup struct {
	Keys []string `json:"keys"`
	IDs  []string `json:"ids"`
}

type keyOrderTitle struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type keyOrderRequest struct {
	Mode      string            `json:"mode"`
	Directory string            `json:"directory"`
	Index     string            `json:"index"`
	Config    map[string]any    `json:"config"`
	Documents []json.RawMessage `json:"documents,omitempty"`
	Query     map[string]any    `json:"query,omitempty"`
	Field     string            `json:"field,omitempty"`
	Updates   []keyOrderTitle   `json:"updates,omitempty"`
	Note      string            `json:"note,omitempty"`
}

func runKeyOrderScript(t *testing.T, request keyOrderRequest) {
	t.Helper()
	node := requireTypeScriptEngine(t)
	requestPath := filepath.Join(t.TempDir(), "request.json")
	writeJSONFile(t, requestPath, request)
	ctx, cancel := context.WithTimeout(context.Background(), nodeScriptDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("testdata", "narsil-ts-key-order.mjs"), requestPath)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("the TypeScript engine failed in %s mode: %v\n%s", request.Mode, err, output.String())
	}
}

func startedInMemory(t *testing.T) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the Go engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func restoredInMemory(t *testing.T, path string) *engine.Narsil {
	t.Helper()
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s failed: %v", path, err)
	}
	narsil := startedInMemory(t)
	if err := narsil.Restore(context.Background(), documentOrderIndex, bytes.NewReader(saved)); err != nil {
		t.Fatalf("the Go engine refused the TypeScript snapshot with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func updatedThroughGet(t *testing.T, narsil *engine.Narsil, id string, key string, value any) {
	t.Helper()
	ctx := context.Background()
	held, found, err := narsil.Get(ctx, documentOrderIndex, id)
	if err != nil || !found {
		t.Fatalf("the Go engine failed to read %q (found %t) with %s: %v", id, found, codeOrMessage(err), err)
	}
	if err := narsil.Update(ctx, documentOrderIndex, id, held.Set(key, value), engine.WriteOptions{}); err != nil {
		t.Fatalf("the Go engine refused the update of %q with %s: %v", id, codeOrMessage(err), err)
	}
}

func groupsByMeta(t *testing.T, narsil *engine.Narsil) []keyOrderGroup {
	t.Helper()
	result, err := narsil.Query(context.Background(), documentOrderIndex, engine.QueryParams{Term: "red",
		Group: &engine.GroupConfig{Fields: []string{documentOrderGroupField}, MaxPerGroup: engine.Some(10)}})
	if err != nil {
		t.Fatalf("the Go engine failed the grouped query with %s: %v", codeOrMessage(err), err)
	}
	groups := make([]keyOrderGroup, 0, len(result.Groups))
	for _, group := range result.Groups {
		value, isDocument := group.Values[documentOrderGroupField].(*engine.Document)
		if !isDocument {
			t.Fatalf("a group holds %T under %q, and the stored value is an object", group.Values[documentOrderGroupField], documentOrderGroupField)
		}
		found := keyOrderGroup{Keys: []string{}, IDs: []string{}}
		for key := range value.All() {
			found.Keys = append(found.Keys, key)
		}
		for _, hit := range group.Hits {
			found.IDs = append(found.IDs, hit.ID)
		}
		groups = append(groups, found)
	}
	return groups
}

func requireTypeScriptGroups(t *testing.T, label string, narsil *engine.Narsil, oraclePath string) {
	t.Helper()
	var oracle []keyOrderGroup
	readJSONFile(t, oraclePath, &oracle)
	if len(oracle) < 2 {
		t.Fatalf("the TypeScript engine found %d groups %s, and two key orders make at least two", len(oracle), label)
	}
	if found := groupsByMeta(t, narsil); !reflect.DeepEqual(found, oracle) {
		t.Fatalf("%s the Go engine groups %+v, while the TypeScript engine groups %+v", label, found, oracle)
	}
}

func TestGroupsByAnUndeclaredObjectKeepTheTypeScriptKeyOrder(t *testing.T) {
	directory := t.TempDir()
	updates := []keyOrderTitle{{ID: "d1", Title: "red apricot"}, {ID: "d4", Title: "red peach"}}
	runKeyOrderScript(t, keyOrderRequest{Mode: "groups", Directory: directory, Index: documentOrderIndex,
		Config: map[string]any{"schema": map[string]string{"title": "string"}, "language": "english"},
		Documents: []json.RawMessage{
			json.RawMessage(`{"id":"d1","title":"red apple","meta":{"b":1,"a":2}}`),
			json.RawMessage(`{"id":"d2","title":"red pear","meta":{"a":2,"b":1}}`),
			json.RawMessage(`{"id":"d3","title":"red plum","meta":{"b":1,"a":2}}`),
			json.RawMessage(`{"id":"d4","title":"red fig","meta":{"a":2,"b":1}}`),
			json.RawMessage(`{"id":"d5","title":"red lime","meta":{"b":1,"a":2,"7":"x","3":"y"}}`),
		},
		Query: map[string]any{"term": "red", "group": map[string]any{"fields": []string{documentOrderGroupField}, "maxPerGroup": 10}},
		Field: documentOrderGroupField, Updates: updates})
	narsil := restoredInMemory(t, filepath.Join(directory, "snapshot.nrsl"))
	requireTypeScriptGroups(t, "after the restore", narsil, filepath.Join(directory, "groups.json"))
	for _, update := range updates {
		updatedThroughGet(t, narsil, update.ID, "title", update.Title)
	}
	requireTypeScriptGroups(t, "after two documents went through Get and Update", narsil, filepath.Join(directory, "groups-updated.json"))
}

func TestGetThenUpdateKeepsTheStoredBytesOfEveryValueKind(t *testing.T) {
	directory := t.TempDir()
	runKeyOrderScript(t, keyOrderRequest{Mode: "kinds", Directory: directory, Index: documentOrderIndex,
		Config: map[string]any{"schema": map[string]string{"title": "string", "note": "string"}, "language": "english"},
		Note:   documentOrderUpdateNote})
	var ids []string
	readJSONFile(t, filepath.Join(directory, "ids.json"), &ids)
	narsil := restoredInMemory(t, filepath.Join(directory, "inserted.nrsl"))
	for _, id := range ids {
		updatedThroughGet(t, narsil, id, "note", documentOrderUpdateNote)
	}
	var saved bytes.Buffer
	if err := narsil.Snapshot(context.Background(), documentOrderIndex, engine.SnapshotOptions{}, &saved); err != nil {
		t.Fatalf("the Go engine failed to save with %s: %v", codeOrMessage(err), err)
	}
	oracle, err := os.ReadFile(filepath.Join(directory, "updated.nrsl"))
	if err != nil {
		t.Fatalf("reading the TypeScript snapshot failed: %v", err)
	}
	if !bytes.Equal(saved.Bytes(), oracle) {
		t.Fatalf("after Get and Update of %d documents the Go snapshot holds %d bytes that differ from the %d bytes of the TypeScript snapshot",
			len(ids), saved.Len(), len(oracle))
	}
}

func heldDocumentID(serial int) string {
	return fmt.Sprintf("doc-%04d", serial)
}

func heldDocumentFields(serial int, body string) map[string]any {
	return map[string]any{"id": heldDocumentID(serial), "body": fmt.Sprintf("%s word%04d", body, serial), "serial": float64(serial),
		"payload": map[string]any{"tags": []any{fmt.Sprintf("tag-%d", serial), "kept"}, "depth": map[string]any{"serial": float64(serial)}}}
}

func heldBatch(body string) ([]*engine.Document, []engine.DocumentUpdate) {
	inserts := make([]*engine.Document, heldDocumentCount)
	updates := make([]engine.DocumentUpdate, heldDocumentCount)
	for serial := range heldDocumentCount {
		inserts[serial] = engine.DocumentFromMap(heldDocumentFields(serial, body))
		updates[serial] = engine.DocumentUpdate{DocID: heldDocumentID(serial), Document: inserts[serial]}
	}
	return inserts, updates
}

func requireBatchWritten(t *testing.T, label string, result engine.BatchResult, err error) {
	t.Helper()
	if err != nil || len(result.Failed) > 0 {
		t.Fatalf("%s failed with %s and %d refused documents: %v", label, codeOrMessage(err), len(result.Failed), err)
	}
}

func heldBeforeLaterWrites(t *testing.T, narsil *engine.Narsil) map[string][]*engine.Document {
	t.Helper()
	ctx := context.Background()
	held := map[string][]*engine.Document{}
	ids := make([]string, heldDocumentCount)
	for serial := range ids {
		ids[serial] = heldDocumentID(serial)
	}
	read, err := narsil.GetMultiple(ctx, documentOrderIndex, ids)
	if err != nil || len(read) != heldDocumentCount {
		t.Fatalf("the engine read %d of %d documents with %s: %v", len(read), heldDocumentCount, codeOrMessage(err), err)
	}
	for id, document := range read {
		held[id] = append(held[id], document)
	}
	result, err := narsil.Query(ctx, documentOrderIndex, engine.QueryParams{Term: "shared", Limit: engine.Some(heldHitLimit)})
	if err != nil || len(result.Hits) != heldHitLimit {
		t.Fatalf("the query returned %d of %d hits with %s: %v", len(result.Hits), heldHitLimit, codeOrMessage(err), err)
	}
	for _, hit := range result.Hits {
		held[hit.ID] = append(held[hit.ID], hit.Document)
	}
	listed, err := narsil.ListDocuments(ctx, documentOrderIndex, engine.ListParams{Limit: engine.Some(heldHitLimit)})
	if err != nil || len(listed.Documents) != heldHitLimit {
		t.Fatalf("the listing returned %d of %d documents with %s: %v", len(listed.Documents), heldHitLimit, codeOrMessage(err), err)
	}
	for _, document := range listed.Documents {
		held[document.ID] = append(held[document.ID], document.Document)
	}
	return held
}

func TestHeldDocumentsOutliveLaterWritesCompactionAndShutdown(t *testing.T) {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync,
			CompactionThreshold: engine.Some(heldCompactionThreshold)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, documentOrderIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english", TextStorage: engine.TextStorageDisk}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	inserts, _ := heldBatch("shared")
	result, err := narsil.InsertBatch(ctx, documentOrderIndex, inserts, engine.InsertOptions{})
	requireBatchWritten(t, "the first insert", result, err)
	held := heldBeforeLaterWrites(t, narsil)
	if err := narsil.Checkpoint(ctx, documentOrderIndex); err != nil {
		t.Fatalf("the first checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	for id, documents := range heldBeforeLaterWrites(t, narsil) {
		held[id] = append(held[id], documents...)
	}
	_, updates := heldBatch("replaced")
	removed := make([]string, heldDocumentsRemoved)
	for serial := range removed {
		removed[serial] = heldDocumentID(serial)
	}
	for round := range heldCompactionThreshold + 1 {
		result, err = narsil.UpdateBatch(ctx, documentOrderIndex, updates[heldDocumentsRemoved*min(round, 1):], engine.WriteOptions{})
		requireBatchWritten(t, "a later update", result, err)
		if round == 0 {
			result, err = narsil.RemoveBatch(ctx, documentOrderIndex, removed, engine.WriteOptions{})
			requireBatchWritten(t, "a later removal", result, err)
		}
		if err := narsil.Checkpoint(ctx, documentOrderIndex); err != nil {
			t.Fatalf("a later checkpoint failed with %s: %v", codeOrMessage(err), err)
		}
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down with %s: %v", codeOrMessage(err), err)
	}
	for serial := range heldDocumentCount {
		expected := heldDocumentFields(serial, "shared")
		for at, document := range held[heldDocumentID(serial)] {
			if found := document.Map(); !reflect.DeepEqual(found, expected) {
				t.Fatalf("read %d of document %q holds %v after the later writes, while the engine returned %v", at, heldDocumentID(serial), found, expected)
			}
		}
	}
}

func TestFirstReadOfAHeldDocumentIsSafeFromSeveralGoroutines(t *testing.T) {
	ctx := context.Background()
	narsil := startedInMemory(t)
	if err := narsil.CreateIndex(ctx, documentOrderIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	expected := map[string]any{"id": "wide", "body": "shared words", "nested": map[string]any{"inner": map[string]any{"leaf": "held"}}}
	for key := range firstReadKeyCount {
		expected[fmt.Sprintf("key-%02d", key)] = float64(key)
	}
	if _, err := narsil.Insert(ctx, documentOrderIndex, engine.DocumentFromMap(expected), "", engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
	}
	read, found, err := narsil.Get(ctx, documentOrderIndex, "wide")
	if err != nil || !found {
		t.Fatalf("the engine failed to read the document (found %t) with %s: %v", found, codeOrMessage(err), err)
	}
	result, err := narsil.Query(ctx, documentOrderIndex, engine.QueryParams{Term: "shared"})
	if err != nil || len(result.Hits) != 1 {
		t.Fatalf("the query returned %d hits with %s: %v", len(result.Hits), codeOrMessage(err), err)
	}
	failures := make(chan string, 2*firstReadGoroutines)
	var readers sync.WaitGroup
	for _, document := range []*engine.Document{read, result.Hits[0].Document} {
		for reader := range firstReadGoroutines {
			readers.Add(1)
			go func() {
				defer readers.Done()
				switch reader % 4 {
				case 0:
					key := fmt.Sprintf("key-%02d", reader)
					if value, held := document.Get(key); !held || value != float64(reader) {
						failures <- fmt.Sprintf("Get(%q) returned %v (held %t)", key, value, held)
					}
				case 1:
					keys := 0
					for range document.All() {
						keys++
					}
					if keys != len(expected) {
						failures <- fmt.Sprintf("All yielded %d of %d keys", keys, len(expected))
					}
				case 2:
					if found := document.Map(); !reflect.DeepEqual(found, expected) {
						failures <- fmt.Sprintf("Map returned %v", found)
					}
				default:
					nested, _ := document.Get("nested")
					inner, isDocument := nested.(*engine.Document)
					if !isDocument || inner.Len() != 1 || document.Len() != len(expected) {
						failures <- fmt.Sprintf("the nested object read as %T beside %d keys", nested, document.Len())
					}
				}
			}()
		}
	}
	readers.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}

func TestDocumentJSONKeepsKeyOrderAtEveryDepth(t *testing.T) {
	const written = `{"zeta":1,"10":"ten","id":"json","alpha":{"y":true,"3":[{"q":null,"1":2.5,"c":"x"},[]],"b":"last"},"2":"two","mid":[1.5,"s"]}`
	const ordered = `{"2":"two","10":"ten","zeta":1,"id":"json","alpha":{"3":[{"1":2.5,"q":null,"c":"x"},[]],"y":true,"b":"last"},"mid":[1.5,"s"]}`
	ctx := context.Background()
	document := engine.NewDocument()
	if err := json.Unmarshal([]byte(written), document); err != nil {
		t.Fatalf("json.Unmarshal refused the document: %v", err)
	}
	encoded, err := json.Marshal(document)
	if err != nil || string(encoded) != ordered {
		t.Fatalf("json.Marshal after json.Unmarshal wrote %s (%v), while JavaScript orders the keys as %s", encoded, err, ordered)
	}
	narsil := startedInMemory(t)
	if err := narsil.CreateIndex(ctx, documentOrderIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	if _, err := narsil.Insert(ctx, documentOrderIndex, document, "", engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
	}
	stored, found, err := narsil.Get(ctx, documentOrderIndex, "json")
	if err != nil || !found {
		t.Fatalf("the engine failed to read the document (found %t) with %s: %v", found, codeOrMessage(err), err)
	}
	if encoded, err = json.Marshal(stored); err != nil || string(encoded) != ordered {
		t.Fatalf("json.Marshal of the stored document wrote %s (%v), while the written order is %s", encoded, err, ordered)
	}
}
