package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	restoreMemoryChildVariable = "NARSIL_RESTORE_MEMORY_CHILD"
	restoreMemoryIndex         = "ledger"
	restoreMemoryLimitBytes    = 48 << 20
	restoreMemoryDocuments     = 2_000
	restoreMemoryWords         = 400
	restoreMemoryVocabulary    = 50_000
	restoreMemorySurvivorID    = "survivor"
	restoreMemorySurvivorBody  = "kept through a restore that does not fit"
)

type restoreMemoryReport struct {
	Code          string         `json:"code"`
	Details       map[string]any `json:"details"`
	Count         int            `json:"count"`
	SurvivorBody  string         `json:"survivorBody"`
	SurvivorFound bool           `json:"survivorFound"`
}

func writeRestoreMemoryArchive(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("starting the source engine failed: %v", err)
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, restoreMemoryIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString}}); err != nil {
		t.Fatalf("creating the source index failed: %v", err)
	}
	random := rand.New(rand.NewSource(11))
	documents := make([]*engine.Document, 0, restoreMemoryDocuments)
	for at := range restoreMemoryDocuments {
		words := make([]string, restoreMemoryWords)
		for word := range words {
			words[word] = fmt.Sprintf("w%d", random.Intn(restoreMemoryVocabulary))
		}
		documents = append(documents, engine.NewDocument().Set("id", fmt.Sprintf("page-%d", at)).
			Set("body", strings.Join(words, " ")))
	}
	if result, err := narsil.InsertBatch(ctx, restoreMemoryIndex, documents, engine.InsertOptions{}); err != nil ||
		len(result.Failed) > 0 {
		t.Fatalf("filling the source index failed: %v %v", err, result.Failed)
	}
	var archive bytes.Buffer
	if err := narsil.Snapshot(ctx, restoreMemoryIndex, engine.SnapshotOptions{}, &archive); err != nil {
		t.Fatalf("writing the snapshot failed: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ledger.nrsl")
	if err := os.WriteFile(path, archive.Bytes(), 0o600); err != nil {
		t.Fatalf("saving the snapshot failed: %v", err)
	}
	return path
}

func runRestoreMemoryChild(archivePath string, output io.Writer) error {
	ctx := context.Background()
	archive, err := os.ReadFile(archivePath)
	if err != nil {
		return err
	}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		return err
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, restoreMemoryIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString}}); err != nil {
		return err
	}
	survivor := engine.NewDocument().Set("id", restoreMemorySurvivorID).Set("body", restoreMemorySurvivorBody)
	if _, err := narsil.Insert(ctx, restoreMemoryIndex, survivor, "", engine.InsertOptions{}); err != nil {
		return err
	}
	report := restoreMemoryReport{}
	if err := narsil.Restore(ctx, restoreMemoryIndex, bytes.NewReader(archive)); err != nil {
		report.Code = engine.ErrorCode(err)
		if held, isEngineError := engine.AsError(err); isEngineError {
			report.Details = held.Details
		}
	}
	if report.Count, err = narsil.CountDocuments(ctx, restoreMemoryIndex); err != nil {
		return err
	}
	stored, found, err := narsil.Get(ctx, restoreMemoryIndex, restoreMemorySurvivorID)
	if err != nil {
		return err
	}
	report.SurvivorFound = found
	if found {
		body, _ := stored.Get("body")
		report.SurvivorBody, _ = body.(string)
	}
	return json.NewEncoder(output).Encode(report)
}

func TestRestoreRefusesAnArchiveThatCannotFitAndKeepsTheIndexServing(t *testing.T) {
	archivePath := writeRestoreMemoryArchive(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), memoryChildDeadline)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^$")
	child.Env = append(os.Environ(), restoreMemoryChildVariable+"="+archivePath,
		fmt.Sprintf("GOMEMLIMIT=%d", restoreMemoryLimitBytes))
	var stdout, stderr bytes.Buffer
	child.Stdout, child.Stderr = &stdout, &stderr
	if err := child.Run(); err != nil {
		t.Fatalf("the restore child under a %d-byte heap limit stopped: %v\n%s", restoreMemoryLimitBytes, err, stderr.String())
	}
	report := restoreMemoryReport{}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("reading the restore child's report failed: %v\n%s", err, stdout.String())
	}
	info, err := os.Stat(archivePath)
	if err != nil {
		t.Fatalf("reading the archive size failed: %v", err)
	}
	if report.Code != engine.CodeRestoreMemoryExceeded || report.Details["indexName"] != restoreMemoryIndex {
		t.Fatalf("restoring a %d-byte archive of %d documents under a %d-byte heap limit answered %q with %v, while it must refuse with %s",
			info.Size(), restoreMemoryDocuments, restoreMemoryLimitBytes, report.Code, report.Details,
			engine.CodeRestoreMemoryExceeded)
	}
	needed, isNumber := report.Details["neededBytes"].(float64)
	available, isAvailable := report.Details["availableBytes"].(float64)
	if !isNumber || !isAvailable || needed <= available || available > restoreMemoryLimitBytes {
		t.Fatalf("the refusal gives %v bytes needed and %v free under a %d-byte limit: %v", report.Details["neededBytes"],
			report.Details["availableBytes"], restoreMemoryLimitBytes, report.Details)
	}
	if report.Count != 1 || !report.SurvivorFound || report.SurvivorBody != restoreMemorySurvivorBody {
		t.Fatalf("after the refusal the index holds %d documents and the survivor reads %q (found %v), while it must hold the survivor alone",
			report.Count, report.SurvivorBody, report.SurvivorFound)
	}
}
