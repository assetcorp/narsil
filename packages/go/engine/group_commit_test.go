package engine_test

import (
	"context"
	"encoding/binary"
	"hash/crc32"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	sharedFlushIndex          = "orders"
	sharedFlushWriters        = 16
	sharedFlushStepsPerWriter = 60
	sharedFlushUpdateEvery    = 3
	sharedFlushRemoveEvery    = 5
	sharedFlushBatchDocuments = 4
	markerSlotBytes           = 36
	markerChecksumOffset      = 32
	markerSlotCount           = 2
)

func markerWriteSeq(t *testing.T, path string) uint64 {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the commit marker %s failed: %v", path, err)
	}
	var highest uint64
	for slot := range markerSlotCount {
		start := slot * markerSlotBytes
		if len(data) < start+markerSlotBytes {
			continue
		}
		bytes := data[start : start+markerSlotBytes]
		if crc32.ChecksumIEEE(bytes[:markerChecksumOffset]) != binary.BigEndian.Uint32(bytes[markerChecksumOffset:]) {
			continue
		}
		highest = max(highest, binary.BigEndian.Uint64(bytes))
	}
	return highest
}

func durableFlushCount(t *testing.T, directory string) uint64 {
	t.Helper()
	markers, err := filepath.Glob(filepath.Join(directory, sharedFlushIndex, "wal", "*", "commit"))
	if err != nil {
		t.Fatalf("listing the commit markers failed: %v", err)
	}
	var total uint64
	for _, path := range markers {
		total += markerWriteSeq(t, path)
	}
	return total
}

type sharedFlushLedger struct {
	mu    sync.Mutex
	held  map[string]string
	calls atomic.Int64
}

func (ledger *sharedFlushLedger) acknowledge(id string, title string, present bool) {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if present {
		ledger.held[id] = title
	} else {
		delete(ledger.held, id)
	}
}

func sharedFlushTitle(id string, version int) map[string]any {
	return map[string]any{"title": id + " version " + strconv.Itoa(version)}
}

func runSharedFlushWriter(ctx context.Context, narsil *engine.Narsil, writer int, ledger *sharedFlushLedger) error {
	for step := range sharedFlushStepsPerWriter {
		id := "w" + strconv.Itoa(writer) + "-" + strconv.Itoa(step)
		document := sharedFlushTitle(id, 0)
		if _, err := narsil.Insert(ctx, sharedFlushIndex, engine.DocumentFromMap(document), id, engine.InsertOptions{}); err != nil {
			return err
		}
		ledger.calls.Add(1)
		ledger.acknowledge(id, document["title"].(string), true)
		if step%sharedFlushUpdateEvery == 0 {
			document = sharedFlushTitle(id, 1)
			if err := narsil.Update(ctx, sharedFlushIndex, id, engine.DocumentFromMap(document), engine.WriteOptions{}); err != nil {
				return err
			}
			ledger.calls.Add(1)
			ledger.acknowledge(id, document["title"].(string), true)
		}
		if step%sharedFlushRemoveEvery == 0 {
			if err := narsil.Remove(ctx, sharedFlushIndex, id, engine.WriteOptions{}); err != nil {
				return err
			}
			ledger.calls.Add(1)
			ledger.acknowledge(id, "", false)
		}
	}
	batch := make([]*engine.Document, 0, sharedFlushBatchDocuments)
	titles := map[string]string{}
	for at := range sharedFlushBatchDocuments {
		id := "w" + strconv.Itoa(writer) + "-batch-" + strconv.Itoa(at)
		document := sharedFlushTitle(id, 0)
		document["id"] = id
		titles[id] = document["title"].(string)
		batch = append(batch, engine.DocumentFromMap(document))
	}
	result, err := narsil.InsertBatch(ctx, sharedFlushIndex, batch, engine.InsertOptions{})
	if err != nil {
		return err
	}
	ledger.calls.Add(1)
	for _, id := range result.Succeeded {
		ledger.acknowledge(id, titles[id], true)
	}
	return nil
}

func openSharedFlushEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func TestConcurrentSyncWritersToOneIndexShareDurableFlushesAndKeepEveryAcknowledgedWrite(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openSharedFlushEngine(t, directory)
	if err := narsil.CreateIndex(ctx, sharedFlushIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	flushesBefore := durableFlushCount(t, directory)
	ledger := &sharedFlushLedger{held: map[string]string{}}
	failures := make([]error, sharedFlushWriters)
	var writers sync.WaitGroup
	for writer := range sharedFlushWriters {
		writers.Go(func() { failures[writer] = runSharedFlushWriter(ctx, narsil, writer, ledger) })
	}
	writers.Wait()
	for writer, err := range failures {
		if err != nil {
			t.Fatalf("writer %d failed with %s: %v", writer, codeOrMessage(err), err)
		}
	}
	flushes := durableFlushCount(t, directory) - flushesBefore
	calls := uint64(ledger.calls.Load())
	t.Logf("%d acknowledged write calls shared %d durable flushes", calls, flushes)
	if flushes >= calls {
		t.Fatalf("the commit markers record %d durable flushes for %d acknowledged write calls from %d concurrent writers, so the writers never shared a flush",
			flushes, calls, sharedFlushWriters)
	}
	shutDown(t, narsil, "after the writers finished")
	reopened := openSharedFlushEngine(t, directory)
	defer shutDown(t, reopened, "at the end")
	stored, err := exportedDocuments(ctx, reopened, sharedFlushIndex)
	if err != nil {
		t.Fatalf("exporting after the restart failed with %s: %v", codeOrMessage(err), err)
	}
	if len(stored) != len(ledger.held) {
		t.Fatalf("after the restart the index holds %d documents, while the acknowledged writes leave %d", len(stored),
			len(ledger.held))
	}
	for id, title := range ledger.held {
		document, held := stored[id].(map[string]any)
		if !held || document["title"] != title {
			t.Fatalf("after the restart %s holds %v, while its last acknowledged write stored %q", id, stored[id], title)
		}
	}
}
