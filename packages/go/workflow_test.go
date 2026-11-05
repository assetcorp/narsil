package narsil_test

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	narsil "github.com/assetcorp/narsil/packages/go"
)

const (
	slashedID      = "guides/north-face"
	spacedID       = "field guide 2"
	accentedID     = "café-été"
	importedCount  = 40
	totalAfterLoad = 43
)

var workflowDocuments = map[string]narsil.AnyDocument{
	slashedID:  {"title": "A mountain path for the north face", "year": 2019.0},
	spacedID:   {"title": "River crossings in spring", "year": 2021.0},
	accentedID: {"title": "The mountain café guide", "year": 2024.0},
}

func titleAndYearSchema() narsil.SchemaDefinition {
	return narsil.SchemaDefinition{
		"title": {FieldType: narsil.Ptr(narsil.FieldTypeString)},
		"year":  {FieldType: narsil.Ptr(narsil.FieldTypeNumber)},
	}
}

func hitIDs(result *narsil.HTTPQueryResult) map[string]bool {
	ids := map[string]bool{}
	for _, hit := range result.Hits {
		ids[hit.ID] = true
	}
	return ids
}

func expectMountainHits(t *testing.T, result *narsil.HTTPQueryResult) {
	t.Helper()
	ids := hitIDs(result)
	if len(ids) != 2 || !ids[slashedID] || !ids[accentedID] || result.Count != 2 {
		t.Fatalf("the search for mountain found %v with count %v", ids, result.Count)
	}
}

func TestClientRunsTheWholeIndexLifecycleOnALiveServer(t *testing.T) {
	ctx := testContext(t)
	client := newClient(t, narsil.Config{URLs: []string{shared.plain.url}})
	name := indexName(t)
	restoredName := name + "_restored"

	created, err := client.CreateIndex(ctx, narsil.HTTPCreateIndexBody{
		Name: name, Config: narsil.HTTPIndexBody{Schema: titleAndYearSchema()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != name {
		t.Fatalf("the server created %q in place of %q", created.Name, name)
	}
	for id, document := range workflowDocuments {
		answer, err := client.Insert(ctx, name, narsil.InsertBody{Document: document, ID: narsil.Ptr(id)})
		if err != nil {
			t.Fatal(err)
		}
		if answer.ID != id {
			t.Fatalf("the server stored %q under %q", id, answer.ID)
		}
	}
	if _, err := client.WaitForWrites(ctx, name); err != nil {
		t.Fatal(err)
	}
	for id, document := range workflowDocuments {
		stored, err := client.Get(ctx, name, id)
		if err != nil {
			t.Fatal(err)
		}
		if stored == nil || stored["title"] != document["title"] || stored["year"] != document["year"] {
			t.Fatalf("the document %q came back as %v", id, stored)
		}
	}
	missing, err := client.Get(ctx, name, "guides/missing")
	if err != nil || missing != nil {
		t.Fatalf("a missing document came back as %v with %v", missing, err)
	}
	exists, err := client.Has(ctx, name, accentedID)
	if err != nil || !exists.Exists {
		t.Fatalf("the accented document exists=%v with %v", exists, err)
	}
	found, err := client.Query(ctx, name, narsil.HTTPQueryParams{Term: narsil.Ptr("mountain")})
	if err != nil {
		t.Fatal(err)
	}
	expectMountainHits(t, found)

	imported := make([]narsil.AnyDocument, importedCount)
	for number := range imported {
		imported[number] = narsil.AnyDocument{
			"id": fmt.Sprintf("import-%d", number), "title": fmt.Sprintf("Imported trail %d", number),
			"year": float64(2000 + number),
		}
	}
	task, err := client.StartImport(ctx, name, imported)
	if err != nil {
		t.Fatal(err)
	}
	var seen []narsil.TaskStatus
	finished, err := client.WaitForTask(ctx, task.ID, narsil.WaitOptions{
		OnProgress: func(record *narsil.TaskRecord) { seen = append(seen, record.Status) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != narsil.TaskStatusSucceeded || finished.Progress == nil ||
		finished.Progress.Indexed != importedCount || finished.Progress.Failed != 0 {
		t.Fatalf("the import finished as %+v", finished)
	}
	if len(seen) == 0 || seen[len(seen)-1] != narsil.TaskStatusSucceeded {
		t.Fatalf("the progress callback saw %v", seen)
	}
	expectCount(t, client, name, totalAfterLoad)

	if _, err := client.Checkpoint(ctx, name); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "index.tar")
	written := saveStream(t, client, name, archive)
	if written == 0 {
		t.Fatal("the snapshot was empty")
	}
	upload, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer upload.Close()
	restoreTask, err := client.Restore(ctx, restoredName, io.MultiReader(upload))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := client.WaitForTask(ctx, restoreTask.ID, narsil.WaitOptions{})
	if err != nil || restored.Status != narsil.TaskStatusSucceeded {
		t.Fatalf("the restore finished as %+v with %v", restored, err)
	}
	expectCount(t, client, restoredName, totalAfterLoad)
	accented, err := client.Get(ctx, restoredName, accentedID)
	if err != nil || accented["title"] != workflowDocuments[accentedID]["title"] {
		t.Fatalf("the restored accented document came back as %v with %v", accented, err)
	}
	restoredHits, err := client.Query(ctx, restoredName, narsil.HTTPQueryParams{Term: narsil.Ptr("mountain")})
	if err != nil {
		t.Fatal(err)
	}
	expectMountainHits(t, restoredHits)

	dropped, err := client.DropIndex(ctx, name)
	if err != nil || !dropped.Dropped {
		t.Fatalf("the drop answered %+v with %v", dropped, err)
	}
	if _, err := client.DropIndex(ctx, restoredName); err != nil {
		t.Fatal(err)
	}
}

func expectCount(t *testing.T, client *narsil.Client, name string, want float64) {
	t.Helper()
	counted, err := client.CountDocuments(testContext(t), name)
	if err != nil {
		t.Fatal(err)
	}
	if counted.Count != want {
		t.Fatalf("the index %s holds %v documents in place of %v", name, counted.Count, want)
	}
}

func saveStream(t *testing.T, client *narsil.Client, name, target string) int64 {
	t.Helper()
	stream, err := client.Snapshot(testContext(t), name)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	sink, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	written, err := io.Copy(sink, stream)
	if err != nil {
		t.Fatal(err)
	}
	return written
}
