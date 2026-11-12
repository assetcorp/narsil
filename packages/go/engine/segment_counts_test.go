package engine_test

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	segmentCountsIndex     = "invoices"
	segmentCountsDocuments = 120
	falseListedDocCount    = "0"
)

func savedInvoices(t *testing.T, directory string, storage engine.TextStorage) {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, savedSizeConfig(directory, 0))
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}, TextStorage: storage}
	if err := narsil.CreateIndex(ctx, segmentCountsIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	batch := make([]*engine.Document, 0, segmentCountsDocuments)
	for number := range segmentCountsDocuments {
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": "invoice-" + strconv.Itoa(number),
			"title": "invoice " + strconv.Itoa(number) + " for freight and handling"}))
	}
	insertEvery(t, narsil, segmentCountsIndex, batch)
	checkpointOf(t, narsil, segmentCountsIndex)
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down with %s: %v", codeOrMessage(err), err)
	}
}

func listFalseDocumentCounts(t *testing.T, directory string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), nodeScriptDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, requireTypeScriptEngine(t),
		filepath.Join("testdata", "narsil-segment-counts-tamper.mjs"), directory, segmentCountsIndex, falseListedDocCount)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("rewriting the listed segment counts failed: %v\n%s", err, output)
	}
}

func TestAManifestListingFalseDocumentCountsIsRefused(t *testing.T) {
	for name, storage := range map[string]engine.TextStorage{"in memory": engine.TextStorageMemory,
		"on disk": engine.TextStorageDisk} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			savedInvoices(t, directory, storage)
			listFalseDocumentCounts(t, directory)
			ctx := context.Background()
			narsil, err := engine.New(ctx, savedSizeConfig(directory, 0))
			if err == nil {
				t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
				_, _, err = narsil.Get(ctx, segmentCountsIndex, "invoice-0")
			}
			if engine.ErrorCode(err) != engine.CodePersistenceLoadFailed {
				t.Fatalf("the index whose manifest lists false counts answered with %s, while it must be refused with %s",
					codeOrMessage(err), engine.CodePersistenceLoadFailed)
			}
			if !strings.Contains(err.Error(), "where the manifest lists "+falseListedDocCount) {
				t.Fatalf("the refusal gives no listed count: %v", err)
			}
		})
	}
}
