package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	memoryChildVariable       = "NARSIL_MEMORY_BLOCK_CHILD"
	memoryChildIdle           = "idle"
	memoryChildBatch          = "batch"
	memoryChildDeadline       = 3 * time.Minute
	memoryIndexName           = "notes"
	memoryIdleLimitBytes      = 32 << 20
	memoryBatchLimitBytes     = 256 << 20
	memoryDefaultBlock        = 0.9
	memoryHugeDistinctWords   = 400_000
	memorySmallTitle          = "harbour lights at dusk"
	memoryBatchDocuments      = 120
	memoryBatchPayloadBytes   = 1 << 20
	memoryResumeRetryDeadline = 10 * time.Second
	memoryResumeRetryPause    = 50 * time.Millisecond
)

type memoryRefusal struct {
	DocID   string         `json:"docId"`
	Code    string         `json:"code"`
	Details map[string]any `json:"details"`
}

type memoryBlockReport struct {
	Refusals     []memoryRefusal `json:"refusals"`
	Succeeded    []string        `json:"succeeded"`
	Count        int             `json:"count"`
	StoredTitle  string          `json:"storedTitle"`
	StoredBytes  map[string]int  `json:"storedBytes"`
	Removed      int             `json:"removed"`
	Resumed      bool            `json:"resumed"`
	CountResumed int             `json:"countResumed"`
}

func memoryBatchID(at int) string {
	return fmt.Sprintf("note-%03d", at)
}

func memoryBatchPayload(at int) string {
	return strings.Repeat("x", memoryBatchPayloadBytes) + memoryBatchID(at)
}

func hugeTitle() string {
	var words strings.Builder
	for at := range memoryHugeDistinctWords {
		fmt.Fprintf(&words, "w%d ", at)
	}
	return words.String()
}

func refusalOf(docID string, err error) memoryRefusal {
	held, isEngineError := engine.AsError(err)
	if !isEngineError {
		return memoryRefusal{DocID: docID, Code: fmt.Sprint(err)}
	}
	return memoryRefusal{DocID: docID, Code: held.Code, Details: held.Details}
}

func startMemoryChildIndex(ctx context.Context) (*engine.Narsil, error) {
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		return nil, err
	}
	return narsil, narsil.CreateIndex(ctx, memoryIndexName, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}})
}

func runMemoryIdleChild(ctx context.Context, narsil *engine.Narsil, report *memoryBlockReport) error {
	small := engine.NewDocument().Set("id", "note-small").Set("title", memorySmallTitle)
	if _, err := narsil.Insert(ctx, memoryIndexName, small, "", engine.InsertOptions{}); err != nil {
		return err
	}
	title := hugeTitle()
	update := engine.NewDocument().Set("title", title)
	if err := narsil.Update(ctx, memoryIndexName, "note-small", update, engine.WriteOptions{}); err != nil {
		report.Refusals = append(report.Refusals, refusalOf("note-small", err))
	}
	huge := engine.NewDocument().Set("id", "note-huge").Set("title", title)
	if _, err := narsil.Insert(ctx, memoryIndexName, huge, "", engine.InsertOptions{}); err != nil {
		report.Refusals = append(report.Refusals, refusalOf("note-huge", err))
	}
	stored, found, err := narsil.Get(ctx, memoryIndexName, "note-small")
	if err != nil || !found {
		return fmt.Errorf("reading note-small back failed: %v", err)
	}
	held, _ := stored.Get("title")
	report.StoredTitle, _ = held.(string)
	return nil
}

func memoryBatchDocumentsOf(from int) []*engine.Document {
	documents := make([]*engine.Document, 0, memoryBatchDocuments-from)
	for at := from; at < memoryBatchDocuments; at++ {
		documents = append(documents, engine.NewDocument().Set("id", memoryBatchID(at)).Set("title", "ledger page").
			Set("payload", memoryBatchPayload(at)))
	}
	return documents
}

func retryInsert(ctx context.Context, narsil *engine.Narsil, document *engine.Document) bool {
	deadline := time.Now().Add(memoryResumeRetryDeadline)
	for time.Now().Before(deadline) {
		if _, err := narsil.Insert(ctx, memoryIndexName, document, "", engine.InsertOptions{}); err == nil {
			return true
		}
		time.Sleep(memoryResumeRetryPause)
	}
	return false
}

func runMemoryBatchChild(ctx context.Context, narsil *engine.Narsil, report *memoryBlockReport) error {
	result, err := narsil.InsertBatch(ctx, memoryIndexName, memoryBatchDocumentsOf(0), engine.InsertOptions{})
	if err != nil {
		return err
	}
	report.Succeeded = result.Succeeded
	for _, failure := range result.Failed {
		report.Refusals = append(report.Refusals, memoryRefusal{DocID: failure.DocID, Code: failure.Err.Code,
			Details: failure.Err.Details})
	}
	report.StoredBytes = map[string]int{}
	for _, docID := range result.Succeeded {
		stored, found, err := narsil.Get(ctx, memoryIndexName, docID)
		if err != nil || !found {
			return fmt.Errorf("reading %s back failed: %v", docID, err)
		}
		payload, _ := stored.Get("payload")
		text, _ := payload.(string)
		report.StoredBytes[docID] = len(text)
	}
	if report.Count, err = narsil.CountDocuments(ctx, memoryIndexName); err != nil {
		return err
	}
	removed, err := narsil.RemoveBatch(ctx, memoryIndexName, result.Succeeded, engine.WriteOptions{})
	if err != nil {
		return err
	}
	report.Removed = len(removed.Succeeded)
	if len(result.Failed) > 0 {
		report.Resumed = retryInsert(ctx, narsil, memoryBatchDocumentsOf(len(result.Succeeded))[0])
	}
	report.CountResumed, err = narsil.CountDocuments(ctx, memoryIndexName)
	return err
}

func runMemoryBlockChild(mode string, output io.Writer) error {
	ctx := context.Background()
	narsil, err := startMemoryChildIndex(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	report := memoryBlockReport{}
	if mode == memoryChildIdle {
		err = runMemoryIdleChild(ctx, narsil, &report)
	} else {
		err = runMemoryBatchChild(ctx, narsil, &report)
	}
	if err != nil {
		return err
	}
	if mode == memoryChildIdle {
		if report.Count, err = narsil.CountDocuments(ctx, memoryIndexName); err != nil {
			return err
		}
	}
	return json.NewEncoder(output).Encode(report)
}

func memoryChildReport(t *testing.T, mode string, limitBytes int) memoryBlockReport {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), memoryChildDeadline)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^$")
	child.Env = append(os.Environ(), memoryChildVariable+"="+mode, fmt.Sprintf("GOMEMLIMIT=%d", limitBytes))
	var stdout, stderr bytes.Buffer
	child.Stdout, child.Stderr = &stdout, &stderr
	if err := child.Run(); err != nil {
		t.Fatalf("the %s child under a %d-byte heap limit stopped: %v\n%s", mode, limitBytes, err, stderr.String())
	}
	report := memoryBlockReport{}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("reading the %s child's report failed: %v\n%s", mode, err, stdout.String())
	}
	return report
}

func detailNumber(t *testing.T, refusal memoryRefusal, key string) float64 {
	t.Helper()
	value, isNumber := refusal.Details[key].(float64)
	if !isNumber {
		t.Fatalf("the refusal of %s gives %s as %v, while it must be a number: %v", refusal.DocID, key,
			refusal.Details[key], refusal.Details)
	}
	return value
}

func requireMemoryRefusal(t *testing.T, refusal memoryRefusal, docID, reason string) {
	t.Helper()
	if refusal.DocID != docID || refusal.Code != engine.CodeMemoryWriteBlocked || refusal.Details["reason"] != reason ||
		refusal.Details["indexName"] != memoryIndexName {
		t.Fatalf("the engine answered %s with %s and %v, while it must refuse it with %s and the reason %s",
			refusal.DocID, refusal.Code, refusal.Details, engine.CodeMemoryWriteBlocked, reason)
	}
}

func TestMemoryBlockRefusesADocumentThatCannotFitEvenOnAnIdleEngine(t *testing.T) {
	report := memoryChildReport(t, memoryChildIdle, memoryIdleLimitBytes)
	if len(report.Refusals) != 2 {
		t.Fatalf("the engine refused %d of the two writes of a %d-word title under a %d-byte heap limit: %v",
			len(report.Refusals), memoryHugeDistinctWords, memoryIdleLimitBytes, report.Refusals)
	}
	ceiling := math.Floor(memoryDefaultBlock * memoryIdleLimitBytes)
	for at, docID := range []string{"note-small", "note-huge"} {
		refusal := report.Refusals[at]
		requireMemoryRefusal(t, refusal, docID, "write_exceeds_memory")
		blockBytes := detailNumber(t, refusal, "blockBytes")
		if blockBytes <= 0 || blockBytes > ceiling || detailNumber(t, refusal, "documentBytes") <= blockBytes {
			t.Fatalf("the refusal of %s gives the block as %v bytes, while the heap limit puts it at most at %v: %v",
				docID, blockBytes, ceiling, refusal.Details)
		}
	}
	if report.Count != 1 || report.StoredTitle != memorySmallTitle {
		t.Fatalf("after the refusals the index holds %d documents and note-small reads %q, while it must hold note-small alone as %q",
			report.Count, report.StoredTitle, memorySmallTitle)
	}
}

func requireBatchStored(t *testing.T, report memoryBlockReport) int {
	t.Helper()
	accepted := len(report.Succeeded)
	if accepted == 0 || accepted+len(report.Refusals) != memoryBatchDocuments || len(report.Refusals) == 0 {
		t.Fatalf("the engine accepted %d and refused %d of %d documents of %d bytes under a %d-byte heap limit, while it must run short partway",
			accepted, len(report.Refusals), memoryBatchDocuments, memoryBatchPayloadBytes, memoryBatchLimitBytes)
	}
	for at, docID := range report.Succeeded {
		if docID != memoryBatchID(at) || report.StoredBytes[docID] != len(memoryBatchPayload(at)) {
			t.Fatalf("accepted document %d is %s holding %d payload bytes, while the batch sent %s with %d",
				at, docID, report.StoredBytes[docID], memoryBatchID(at), len(memoryBatchPayload(at)))
		}
	}
	if report.Count != accepted {
		t.Fatalf("the index holds %d documents after the batch, while the engine accepted %d", report.Count, accepted)
	}
	return accepted
}

func TestMemoryBlockRefusesTheRestOfABatchThatRunsShortOfMemory(t *testing.T) {
	report := memoryChildReport(t, memoryChildBatch, memoryBatchLimitBytes)
	accepted := requireBatchStored(t, report)
	first := report.Refusals[0]
	requireMemoryRefusal(t, first, memoryBatchID(accepted), "write_would_fill_memory")
	blockBytes := detailNumber(t, first, "blockBytes")
	needed := detailNumber(t, first, "documentBytes") + detailNumber(t, first, "projectedBytes")
	if blockBytes > math.Floor(memoryDefaultBlock*memoryBatchLimitBytes) ||
		(detailNumber(t, first, "heapBytes")+needed <= blockBytes && detailNumber(t, first, "processBytes")+needed <= blockBytes) {
		t.Fatalf("the engine refused %s although its figures leave room for it below the block: %v", first.DocID, first.Details)
	}
	for at, refusal := range report.Refusals[1:] {
		docID := memoryBatchID(accepted + 1 + at)
		requireMemoryRefusal(t, refusal, docID, "write_would_fill_memory")
		if refusal.Details["docId"] != docID || refusal.Details["refusedDocId"] != first.DocID {
			t.Fatalf("the engine refused %s with %v, while it must name %s as the document that ran short", docID,
				refusal.Details, first.DocID)
		}
	}
	if report.Removed != accepted || !report.Resumed || report.CountResumed != 1 {
		t.Fatalf("after the batch the engine removed %d of %d documents, resumed writes %v, and holds %d documents, while it must remove all, accept %s again, and hold it alone",
			report.Removed, accepted, report.Resumed, report.CountResumed, first.DocID)
	}
}
