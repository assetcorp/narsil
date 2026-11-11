package engine_test

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	tamperedDocumentID = "tampered"
	intactDocumentID   = "intact"
	harmlessKey        = "protoname"
	refusedKey         = "__proto__"
	refusedKeyMessage  = "A stored document is not MessagePack: The key __proto__ is not allowed"
)

type tamperedDocument struct {
	document       *engine.Document
	corruptField   string
	failsEveryRead bool
}

func tamperedDocuments() map[string]tamperedDocument {
	return map[string]tamperedDocument{
		"at the top level": {engine.NewDocument().Set(harmlessKey, "hidden"), harmlessKey, true},
		"in a nested object": {engine.NewDocument().Set("meta", engine.NewDocument().Set(harmlessKey, "hidden")),
			"meta", false},
		"in an object inside a list": {engine.NewDocument().Set("items", []any{"first", engine.NewDocument().Set(harmlessKey, "hidden")}),
			"items", false},
	}
}

func insertTamperable(t *testing.T, narsil *engine.Narsil, tampered *engine.Document) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, documentOrderIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	intact := engine.NewDocument().Set("id", intactDocumentID).Set("body", "shared words")
	for _, document := range []*engine.Document{intact, tampered.Set("id", tamperedDocumentID).Set("body", "shared words")} {
		if _, err := narsil.Insert(ctx, documentOrderIndex, document, "", engine.InsertOptions{}); err != nil {
			t.Fatalf("the engine refused the document with %s: %v", codeOrMessage(err), err)
		}
	}
}

func runTamperScript(t *testing.T, arguments ...string) {
	t.Helper()
	node := requireTypeScriptEngine(t)
	script := filepath.Join("testdata", "narsil-stored-document-tamper.mjs")
	command := exec.CommandContext(context.Background(), node, append([]string{script}, arguments...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("rewriting the stored document failed: %v\n%s", err, output)
	}
}

func tamperedSnapshot(t *testing.T, tampered *engine.Document) []byte {
	t.Helper()
	narsil := startedInMemory(t)
	insertTamperable(t, narsil, tampered)
	var saved bytes.Buffer
	if err := narsil.Snapshot(context.Background(), documentOrderIndex, engine.SnapshotOptions{}, &saved); err != nil {
		t.Fatalf("the engine refused the snapshot with %s: %v", codeOrMessage(err), err)
	}
	directory := t.TempDir()
	archivePath, tamperedPath := filepath.Join(directory, "saved.tar"), filepath.Join(directory, "tampered.tar")
	if err := os.WriteFile(archivePath, saved.Bytes(), 0o644); err != nil {
		t.Fatalf("writing the snapshot failed: %v", err)
	}
	runTamperScript(t, "archive", archivePath, tamperedPath, harmlessKey, refusedKey)
	rewritten, err := os.ReadFile(tamperedPath)
	if err != nil {
		t.Fatalf("reading the rewritten snapshot failed: %v", err)
	}
	return rewritten
}

func startedOn(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start on %s with %s: %v", directory, codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func tamperedDirectory(t *testing.T, tampered *engine.Document) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	narsil := startedOn(t, directory)
	insertTamperable(t, narsil, tampered)
	if err := narsil.Checkpoint(ctx, documentOrderIndex); err != nil {
		t.Fatalf("the engine refused the checkpoint with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down with %s: %v", codeOrMessage(err), err)
	}
	runTamperScript(t, "directory", directory, documentOrderIndex, harmlessKey, refusedKey)
	return startedOn(t, directory)
}

func requireLoadFailure(t *testing.T, action string, err error) {
	t.Helper()
	failure, isEngineError := engine.AsError(err)
	if !isEngineError || failure.Code != engine.CodePersistenceLoadFailed || failure.Message != refusedKeyMessage {
		t.Fatalf("%s returned %s (%v), while TypeScript raises %s with the message %q", action, codeOrMessage(err), err,
			engine.CodePersistenceLoadFailed, refusedKeyMessage)
	}
}

func TestARestoreRefusesAStoredDocumentThatDoesNotDecode(t *testing.T) {
	for name, tampered := range tamperedDocuments() {
		t.Run(name, func(t *testing.T) {
			archive := tamperedSnapshot(t, tampered.document)
			err := startedInMemory(t).Restore(context.Background(), documentOrderIndex, bytes.NewReader(archive))
			requireLoadFailure(t, "the restore", err)
		})
	}
}

func TestReadsOfAStoredDocumentThatDoesNotDecodeRaiseALoadFailure(t *testing.T) {
	for name, tampered := range tamperedDocuments() {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			narsil := tamperedDirectory(t, tampered.document)
			held, found, err := narsil.Get(ctx, documentOrderIndex, tamperedDocumentID)
			if err == nil {
				t.Fatalf("Get returned the document %v (found %t) without an error", held.Map(), found)
			}
			requireLoadFailure(t, "Get", err)
			_, err = narsil.GetMultiple(ctx, documentOrderIndex, []string{intactDocumentID, tamperedDocumentID})
			requireLoadFailure(t, "GetMultiple", err)
			intact, found, err := narsil.Get(ctx, documentOrderIndex, intactDocumentID)
			if err != nil || !found || intact.Len() != 2 {
				t.Fatalf("the intact document read as %v (found %t) with %s: %v", intact.Map(), found, codeOrMessage(err), err)
			}
			result, err := narsil.Query(ctx, documentOrderIndex, engine.QueryParams{Term: "shared"})
			if err == nil {
				for _, hit := range result.Hits {
					if hit.ID == tamperedDocumentID {
						t.Fatalf("the query returned the hit %v without an error", hit.Document.Map())
					}
				}
			}
			requireLoadFailure(t, "Query", err)
			_, err = narsil.Query(ctx, documentOrderIndex, engine.QueryParams{Term: "shared", Document: engine.ExcludeFields("rank")})
			requireLoadFailure(t, "Query with a selected-field projection", err)
			_, err = narsil.ListDocuments(ctx, documentOrderIndex, engine.ListParams{})
			requireLoadFailure(t, "ListDocuments", err)
			requireReadsOfFields(t, narsil, tampered)
		})
	}
}

func requireReadsOfFields(t *testing.T, narsil *engine.Narsil, tampered tamperedDocument) {
	t.Helper()
	ctx := context.Background()
	include := func(field string) engine.QueryParams {
		return engine.QueryParams{Term: "shared", Document: engine.IncludeFields(field)}
	}
	grouped := func(field string) engine.QueryParams {
		return engine.QueryParams{Term: "shared", Document: engine.IncludeFields("body"), Group: &engine.GroupConfig{Fields: []string{field}}}
	}
	_, err := narsil.Query(ctx, documentOrderIndex, include(tampered.corruptField))
	requireLoadFailure(t, "Query including the corrupt field", err)
	_, err = narsil.ListDocuments(ctx, documentOrderIndex, engine.ListParams{Document: engine.IncludeFields(tampered.corruptField)})
	requireLoadFailure(t, "ListDocuments including the corrupt field", err)
	_, err = narsil.Query(ctx, documentOrderIndex, grouped(tampered.corruptField))
	requireLoadFailure(t, "Query grouped by the corrupt field", err)
	_, groupErr := narsil.Query(ctx, documentOrderIndex, grouped("body"))
	result, err := narsil.Query(ctx, documentOrderIndex, include("body"))
	listed, listErr := narsil.ListDocuments(ctx, documentOrderIndex, engine.ListParams{Document: engine.IncludeFields("body")})
	if tampered.failsEveryRead {
		requireLoadFailure(t, "Query including another field", err)
		requireLoadFailure(t, "ListDocuments including another field", listErr)
		requireLoadFailure(t, "Query grouped by another field", groupErr)
		return
	}
	if err != nil || listErr != nil || groupErr != nil {
		t.Fatalf("reads of the intact body failed, while TypeScript answers them: query %v, list %v, grouped %v", err, listErr, groupErr)
	}
	shown := map[string]*engine.Document{}
	for _, hit := range result.Hits {
		shown[hit.ID] = hit.Document
	}
	for _, entry := range listed.Documents {
		if shown[entry.ID] == nil {
			t.Fatalf("the list holds %s, which the query never returned", entry.ID)
		}
		requireOnlyBody(t, "ListDocuments", entry.Document)
	}
	if len(shown) != 2 || len(listed.Documents) != 2 {
		t.Fatalf("the query returned %d documents and the list %d, while both indexes hold 2", len(shown), len(listed.Documents))
	}
	for _, document := range shown {
		requireOnlyBody(t, "Query", document)
	}
}

func requireOnlyBody(t *testing.T, action string, document *engine.Document) {
	t.Helper()
	body, found := document.Get("body")
	if !found || body != "shared words" || document.Len() != 1 {
		t.Fatalf("%s returned %v, while TypeScript returns the body alone", action, document.Map())
	}
}
