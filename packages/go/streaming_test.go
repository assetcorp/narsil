package narsil_test

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
)

const (
	bulkDocumentCount      = 6000
	bulkTextBytes          = 2048
	minimumArchiveBytes    = 8 * 1024 * 1024
	allocatedFractionLimit = 8
	exportHeaderLines      = 1
)

func allocatedWhile(t *testing.T, action func() int64) (int64, uint64) {
	t.Helper()
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	moved := action()
	runtime.ReadMemStats(&after)
	return moved, after.TotalAlloc - before.TotalAlloc
}

func countLines(t *testing.T, path string) int {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	lines := 0
	for scanner.Scan() {
		lines++
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func copyToFile(t *testing.T, stream *narsil.ResponseStream, target string) int64 {
	t.Helper()
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

func TestSnapshotsExportsAndRestoresMoveWithoutHoldingTheWholeBody(t *testing.T) {
	ctx := testContext(t)
	client := newClient(t, narsil.Config{URLs: []string{shared.plain.url}, Timeout: 2 * time.Minute})
	name := indexName(t)
	restoredName := name + "_restored"
	if _, err := client.CreateIndex(ctx, narsil.HTTPCreateIndexBody{
		Name:   name,
		Config: narsil.HTTPIndexBody{Schema: narsil.SchemaDefinition{"body": {FieldType: narsil.Ptr(narsil.FieldTypeString)}}},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = client.DropIndex(testContext(t), name)
		_, _ = client.DropIndex(testContext(t), restoredName)
	})
	documents := make([]narsil.AnyDocument, bulkDocumentCount)
	for number := range documents {
		text := make([]byte, bulkTextBytes/2)
		if _, err := rand.Read(text); err != nil {
			t.Fatal(err)
		}
		documents[number] = narsil.AnyDocument{"id": fmt.Sprintf("bulk-%d", number), "body": hex.EncodeToString(text)}
	}
	imported, err := client.ImportDocuments(ctx, name, documents)
	if err != nil || imported.Indexed != bulkDocumentCount {
		t.Fatalf("the import answered %+v with %v", imported, err)
	}
	documents = nil
	if _, err := client.Checkpoint(ctx, name); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(t.TempDir(), "index.tar")
	archiveBytes, snapshotAllocated := allocatedWhile(t, func() int64 {
		stream, err := client.Snapshot(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		return copyToFile(t, stream, archive)
	})
	if archiveBytes < minimumArchiveBytes || snapshotAllocated*allocatedFractionLimit >= uint64(archiveBytes) {
		t.Fatalf("the snapshot moved %d bytes and allocated %d", archiveBytes, snapshotAllocated)
	}

	export := filepath.Join(t.TempDir(), "documents.ndjson")
	exportBytes, exportAllocated := allocatedWhile(t, func() int64 {
		stream, err := client.ExportDocuments(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		return copyToFile(t, stream, export)
	})
	if exportBytes < bulkDocumentCount*bulkTextBytes || exportAllocated*allocatedFractionLimit >= uint64(exportBytes) {
		t.Fatalf("the export moved %d bytes and allocated %d", exportBytes, exportAllocated)
	}
	if lines := countLines(t, export); lines != exportHeaderLines+bulkDocumentCount {
		t.Fatalf("the export holds %d lines", lines)
	}

	var restoreTask *narsil.TaskRecord
	_, restoreAllocated := allocatedWhile(t, func() int64 {
		upload, err := os.Open(archive)
		if err != nil {
			t.Fatal(err)
		}
		defer upload.Close()
		restoreTask, err = client.Restore(ctx, restoredName, upload)
		if err != nil {
			t.Fatal(err)
		}
		return 0
	})
	if restoreAllocated*allocatedFractionLimit >= uint64(archiveBytes) {
		t.Fatalf("the restore of %d bytes allocated %d", archiveBytes, restoreAllocated)
	}
	finished, err := client.WaitForTask(ctx, restoreTask.ID, narsil.WaitOptions{})
	if err != nil || finished.Status != narsil.TaskStatusSucceeded {
		t.Fatalf("the restore finished as %+v with %v", finished, err)
	}
	expectCount(t, client, restoredName, bulkDocumentCount)
}
