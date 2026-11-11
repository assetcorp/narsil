package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	restoreRefusalIndex = "refusals"
	survivingDocumentID = "survivor"
	survivingBody       = "kept through a refused restore"
)

type restoreRefusalRequest struct {
	Mode      string           `json:"mode"`
	Index     string           `json:"index"`
	Config    map[string]any   `json:"config,omitempty"`
	Documents []map[string]any `json:"documents,omitempty"`
	Snapshot  string           `json:"snapshot"`
	Outcome   string           `json:"outcome,omitempty"`
}

type typeScriptRestoreOutcome struct {
	Code    *string `json:"code"`
	Message string  `json:"message"`
}

func runRestoreRefusalScript(t *testing.T, request restoreRefusalRequest) {
	t.Helper()
	node := requireTypeScriptEngine(t)
	requestPath := filepath.Join(t.TempDir(), "request.json")
	writeJSONFile(t, requestPath, request)
	ctx, cancel := context.WithTimeout(context.Background(), nodeScriptDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("testdata", "narsil-ts-restore-refusal.mjs"), requestPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("the TypeScript engine failed in %s mode: %v\n%s", request.Mode, err, output)
	}
}

func typeScriptSnapshots(t *testing.T, tampered map[string]any) (string, string) {
	t.Helper()
	directory := t.TempDir()
	saved, rewritten := filepath.Join(directory, "saved.nrsl"), filepath.Join(directory, "tampered.nrsl")
	tampered["id"], tampered["body"] = tamperedDocumentID, "shared words"
	runRestoreRefusalScript(t, restoreRefusalRequest{Mode: "write", Index: restoreRefusalIndex,
		Config:    map[string]any{"schema": map[string]any{"body": "string"}, "language": "english"},
		Documents: []map[string]any{{"id": intactDocumentID, "body": "shared words"}, tampered},
		Snapshot:  saved})
	ctx, cancel := context.WithTimeout(context.Background(), nodeScriptDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, requireTypeScriptEngine(t),
		filepath.Join("testdata", "narsil-stored-document-tamper.mjs"), "archive", saved, rewritten, harmlessKey,
		refusedKey)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("rewriting the stored document failed: %v\n%s", err, output)
	}
	return saved, rewritten
}

func typeScriptRestoreCode(t *testing.T, snapshot string) string {
	t.Helper()
	outcome := filepath.Join(t.TempDir(), "outcome.json")
	runRestoreRefusalScript(t, restoreRefusalRequest{Mode: "restore", Index: restoreRefusalIndex, Snapshot: snapshot,
		Outcome: outcome})
	raw, err := os.ReadFile(outcome)
	if err != nil {
		t.Fatalf("reading the TypeScript restore outcome failed: %v", err)
	}
	var decoded typeScriptRestoreOutcome
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("the TypeScript restore outcome %s is not JSON: %v", raw, err)
	}
	if decoded.Code == nil {
		return ""
	}
	return *decoded.Code
}

func restoreFrom(t *testing.T, narsil *engine.Narsil, snapshot string) error {
	t.Helper()
	saved, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatalf("reading %s failed: %v", snapshot, err)
	}
	return narsil.Restore(context.Background(), restoreRefusalIndex, bytes.NewReader(saved))
}

func durableEngine(t *testing.T) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func engineHoldingSurvivor(t *testing.T) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil := startedInMemory(t)
	if err := narsil.CreateIndex(ctx, restoreRefusalIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	survivor := engine.NewDocument().Set("id", survivingDocumentID).Set("body", survivingBody)
	if _, err := narsil.Insert(ctx, restoreRefusalIndex, survivor, "", engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func requireRefusedRestore(t *testing.T, narsil *engine.Narsil, snapshot string) {
	t.Helper()
	err := restoreFrom(t, narsil, snapshot)
	if engine.ErrorCode(err) != engine.CodePersistenceLoadFailed {
		t.Fatalf("the restore returned %s, while a snapshot whose stored document does not decode is refused with %s",
			codeOrMessage(err), engine.CodePersistenceLoadFailed)
	}
}

func requireNoRestoredIndex(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	_, _, err := narsil.Get(context.Background(), restoreRefusalIndex, intactDocumentID)
	if engine.ErrorCode(err) != engine.CodeIndexNotFound {
		t.Fatalf("after the refused restore, Get returned %s, while the index must be missing", codeOrMessage(err))
	}
}

func requireSurvivor(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	ctx := context.Background()
	held, found, err := narsil.Get(ctx, restoreRefusalIndex, survivingDocumentID)
	if err != nil || !found {
		t.Fatalf("after the refused restore, the live document read as found %t with %s: %v", found, codeOrMessage(err), err)
	}
	if body, _ := held.Get("body"); body != survivingBody {
		t.Fatalf("after the refused restore, the live document holds the body %v", body)
	}
	if _, found, err := narsil.Get(ctx, restoreRefusalIndex, intactDocumentID); err != nil || found {
		t.Fatalf("after the refused restore, the snapshot's document read as found %t with %s", found, codeOrMessage(err))
	}
	result, err := narsil.Query(ctx, restoreRefusalIndex, engine.QueryParams{Term: "refused"})
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != survivingDocumentID {
		t.Fatalf("after the refused restore, the query returned %+v with %s", result, codeOrMessage(err))
	}
}

func TestARestoreRefusesASnapshotWhoseStoredDocumentDoesNotDecode(t *testing.T) {
	cases := map[string]map[string]any{
		"at the top level":           {harmlessKey: "hidden"},
		"in a nested object":         {"meta": map[string]any{harmlessKey: "hidden"}},
		"in an object inside a list": {"items": []any{"first", map[string]any{harmlessKey: "hidden"}}},
	}
	for name, tampered := range cases {
		t.Run(name, func(t *testing.T) {
			saved, rewritten := typeScriptSnapshots(t, tampered)
			if code := typeScriptRestoreCode(t, rewritten); code != engine.CodePersistenceLoadFailed {
				t.Fatalf("the TypeScript engine answered the tampered snapshot with %q, while it must refuse it with %s",
					code, engine.CodePersistenceLoadFailed)
			}
			intact := startedInMemory(t)
			if err := restoreFrom(t, intact, saved); err != nil {
				t.Fatalf("the snapshot before tampering was refused with %s: %v", codeOrMessage(err), err)
			}
			if _, found, err := intact.Get(context.Background(), restoreRefusalIndex, tamperedDocumentID); err != nil || !found {
				t.Fatalf("the snapshot before tampering lost its document: found %t with %s", found, codeOrMessage(err))
			}

			inMemory := startedInMemory(t)
			requireRefusedRestore(t, inMemory, rewritten)
			requireNoRestoredIndex(t, inMemory)

			durable := durableEngine(t)
			requireRefusedRestore(t, durable, rewritten)
			requireNoRestoredIndex(t, durable)

			replacing := engineHoldingSurvivor(t)
			requireRefusedRestore(t, replacing, rewritten)
			requireSurvivor(t, replacing)
		})
	}
}
