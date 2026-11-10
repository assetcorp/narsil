package engine_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

var (
	declaredSchemaOrder = []string{"title", "body", "rank", "zone"}
	sortedSchemaOrder   = []string{"body", "rank", "title", "zone"}
)

func declaredSchema() *engine.Document {
	return engine.NewDocument().Set("title", "string").Set("body", "string").Set("rank", "number").Set("zone", "enum")
}

func exportedSchemaOrder(t *testing.T, exported []byte) []string {
	t.Helper()
	header, _, _ := bytes.Cut(exported, []byte("\n"))
	var paths []string
	for _, path := range jsonKeyPaths(t, header) {
		if field, under := strings.CutPrefix(path, "/index/schema/"); under {
			paths = append(paths, field)
		}
	}
	var leaves []string
	for at, path := range paths {
		if at+1 < len(paths) && strings.HasPrefix(paths[at+1], path+"/") {
			continue
		}
		leaves = append(leaves, strings.ReplaceAll(path, "/", "."))
	}
	return leaves
}

func goExportOrder(t *testing.T, narsil *engine.Narsil, moment string) []string {
	t.Helper()
	var exported bytes.Buffer
	if err := narsil.ExportDocuments(context.Background(), restoreRefusalIndex, &exported); err != nil {
		t.Fatalf("%s, the export failed with %s: %v", moment, codeOrMessage(err), err)
	}
	return exportedSchemaOrder(t, exported.Bytes())
}

func typeScriptExportOrder(t *testing.T, snapshot string) []string {
	t.Helper()
	outcome := filepath.Join(t.TempDir(), "export.jsonl")
	runRestoreRefusalScript(t, restoreRefusalRequest{Mode: "export", Index: restoreRefusalIndex, Snapshot: snapshot,
		Outcome: outcome})
	exported, err := os.ReadFile(outcome)
	if err != nil {
		t.Fatalf("reading the TypeScript export failed: %v", err)
	}
	return exportedSchemaOrder(t, exported)
}

func requireSchemaOrder(t *testing.T, moment string, got []string, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("%s, the schema keys are in the order %v, while they must be in the order %v", moment, got, want)
	}
}

func declaredSnapshot(t *testing.T) string {
	t.Helper()
	saved := filepath.Join(t.TempDir(), "declared.nrsl")
	runRestoreRefusalScript(t, restoreRefusalRequest{Mode: "write", Index: restoreRefusalIndex,
		Config: map[string]any{"schema": declaredSchema(), "language": "english"},
		Documents: []map[string]any{{"id": "harbour", "title": "harbour lights", "body": "a quiet quay", "rank": 1,
			"zone": "north"}},
		Snapshot: saved})
	return saved
}

func TestAnImportedIndexKeepsTheSchemaOrderOfItsExport(t *testing.T) {
	ctx := context.Background()
	restored := failedLoadEngine(t, t.TempDir())
	defer shutDown(t, restored, "at the end")
	if err := restoreFrom(t, restored, declaredSnapshot(t)); err != nil {
		t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
	}
	var exported bytes.Buffer
	if err := restored.ExportDocuments(ctx, restoreRefusalIndex, &exported); err != nil {
		t.Fatalf("the export failed with %s: %v", codeOrMessage(err), err)
	}
	requireSchemaOrder(t, "in the export", exportedSchemaOrder(t, exported.Bytes()), declaredSchemaOrder)

	directory := t.TempDir()
	importer := failedLoadEngine(t, directory)
	result, err := importer.ImportDocumentExport(ctx, restoreRefusalIndex, bytes.NewReader(exported.Bytes()))
	if err != nil || result.Imported != 1 || result.RefusedCount != 0 {
		t.Fatalf("the import brought in %d documents and refused %d, with %s: %v", result.Imported,
			result.RefusedCount, codeOrMessage(err), err)
	}
	requireSchemaOrder(t, "after the import", goExportOrder(t, importer, "after the import"), declaredSchemaOrder)
	shutDown(t, importer, "before the restart")
	reopened := failedLoadEngine(t, directory)
	defer shutDown(t, reopened, "at the end")
	requireSchemaOrder(t, "after a restart that followed the import",
		goExportOrder(t, reopened, "after a restart that followed the import"), declaredSchemaOrder)
}

func TestARestoredIndexKeepsTheSchemaOrderThatItRead(t *testing.T) {
	ctx := context.Background()
	saved := declaredSnapshot(t)
	requireSchemaOrder(t, "in the TypeScript export of its own snapshot", typeScriptExportOrder(t, saved),
		declaredSchemaOrder)

	directory := t.TempDir()
	restored := failedLoadEngine(t, directory)
	if err := restoreFrom(t, restored, saved); err != nil {
		t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
	}
	requireSchemaOrder(t, "after the restore", goExportOrder(t, restored, "after the restore"), declaredSchemaOrder)
	written := filepath.Join(t.TempDir(), "rewritten.nrsl")
	var snapshot bytes.Buffer
	if err := restored.Snapshot(ctx, restoreRefusalIndex, engine.SnapshotOptions{}, &snapshot); err != nil {
		t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	if err := os.WriteFile(written, snapshot.Bytes(), 0o644); err != nil {
		t.Fatalf("writing the snapshot failed: %v", err)
	}
	if err := restored.Checkpoint(ctx, restoreRefusalIndex); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	shutDown(t, restored, "after the restore")
	requireSchemaOrder(t, "in the TypeScript export of the Go snapshot", typeScriptExportOrder(t, written),
		declaredSchemaOrder)

	reopened := failedLoadEngine(t, directory)
	defer shutDown(t, reopened, "at the end")
	requireSchemaOrder(t, "after a restart", goExportOrder(t, reopened, "after a restart"), declaredSchemaOrder)

	created := startedInMemory(t)
	if err := created.CreateIndex(ctx, restoreRefusalIndex, engine.IndexConfig{Language: "english",
		Schema: engine.Schema{"title": engine.FieldString, "body": engine.FieldString, "rank": engine.FieldNumber,
			"zone": engine.FieldEnum}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	requireSchemaOrder(t, "for an index created in Go", goExportOrder(t, created, "for an index created in Go"),
		sortedSchemaOrder)
}
