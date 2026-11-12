package engine_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	historySegmentBytes = 4096
	historyResyncWait   = 20 * time.Second
	historyPollInterval = 20 * time.Millisecond
)

type exportedIndex struct {
	keys      []string
	epoch     string
	positions []engine.ChangePosition
	documents map[string]map[string]any
}

func headerKeys(t *testing.T, line []byte) []string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(line))
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("the export header is not a JSON object: %v", err)
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("the export header cannot be read: %v", err)
		}
		keys = append(keys, token.(string))
		var skipped json.RawMessage
		if err := decoder.Decode(&skipped); err != nil {
			t.Fatalf("the export header value of %v cannot be read: %v", token, err)
		}
	}
	return keys
}

func plainTicket(document map[string]any) map[string]any {
	if values, isList := document["embedding"].([]any); isList {
		embedding := make([]float32, len(values))
		for at, value := range values {
			embedding[at] = float32(value.(float64))
		}
		document["embedding"] = embedding
	}
	return document
}

func exportIndex(t *testing.T, narsil *engine.Narsil) exportedIndex {
	t.Helper()
	var written bytes.Buffer
	if err := narsil.ExportDocuments(context.Background(), changesIndex, &written); err != nil {
		t.Fatalf("the export failed with %s: %v", codeOrMessage(err), err)
	}
	scanner := bufio.NewScanner(&written)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<24)
	if !scanner.Scan() {
		t.Fatal("the export holds no header")
	}
	exported := exportedIndex{keys: headerKeys(t, scanner.Bytes()), documents: map[string]map[string]any{}}
	var header struct {
		Epoch     string `json:"epoch"`
		Positions []struct {
			PartitionID uint32 `json:"partitionId"`
			SeqNo       uint64 `json:"seqNo"`
		} `json:"positions"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
		t.Fatalf("the export header cannot be decoded: %v", err)
	}
	exported.epoch = header.Epoch
	for _, position := range header.Positions {
		exported.positions = append(exported.positions, engine.ChangePosition{PartitionID: position.PartitionID,
			SeqNo: position.SeqNo})
	}
	for scanner.Scan() {
		var document map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &document); err != nil {
			t.Fatalf("an export line cannot be decoded: %v", err)
		}
		id := document["id"].(string)
		delete(document, "id")
		exported.documents[id] = plainTicket(document)
	}
	return exported
}

func subscriberOfExport(exported exportedIndex) *subscriber {
	positions := make([]uint64, len(exported.positions))
	for _, position := range exported.positions {
		positions[position.PartitionID] = position.SeqNo
	}
	return &subscriber{epoch: exported.epoch, positions: positions, documents: exported.documents,
		applied: map[string]int{}}
}

func catchUpWithoutChecks(t *testing.T, reader *subscriber, tap *changesTap, oracle *writeOracle) {
	t.Helper()
	expected := oracle.snapshot()
	deadline := time.Now().Add(changesEventWait)
	for !reflectEqualDocuments(reader.documents, expected) {
		if time.Now().After(deadline) {
			reader.requireMatches(t, expected)
		}
		select {
		case received := <-tap.events:
			if received.err != nil || received.event.Group == nil {
				t.Fatalf("while catching up the iteration sent %+v with error %s", received.event,
					codeOrMessage(received.err))
			}
			reader.apply(t, received.event.Group, nil)
		case <-time.After(changesQuietPeriod):
		}
	}
}

func reflectEqualDocuments(left, right map[string]map[string]any) bool {
	if len(left) != len(right) {
		return false
	}
	for id, document := range right {
		held, found := left[id]
		if !found || !jsonEqual(held, document) {
			return false
		}
	}
	return true
}

func jsonEqual(left, right map[string]any) bool {
	leftBytes, leftErr := json.Marshal(left)
	rightBytes, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftBytes, rightBytes)
}

func TestAReaderBehindTheHistoryLimitResyncsAndResumesFromAnExportWithoutAGap(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), historySegmentBytes)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true, PreviousDocument: true,
		HistoryMaxBytes: engine.Some(int64(1))})
	start := tapChanges(t, narsil, engine.ChangesRequest{})
	behind := newSubscriber(start.subscribed(t))
	start.stop()
	oracle := newWriteOracle()
	for round := range 3 {
		writeTicketRound(t, narsil, oracle, round)
		if err := narsil.Checkpoint(ctx, changesIndex); err != nil {
			t.Fatalf("checkpoint %d failed with %s: %v", round, codeOrMessage(err), err)
		}
	}
	deadline := time.Now().Add(historyResyncWait)
	for {
		event, err := firstOutcome(t, narsil, behind.request())
		if err != nil {
			t.Fatalf("the request of a reader behind the history failed with %s: %v", codeOrMessage(err), err)
		}
		if event.Resync != nil {
			if event.Resync.Reason != engine.ResyncHistory {
				t.Fatalf("the reader behind the history received a resync for %q", event.Resync.Reason)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the reader behind a one-byte history limit never received a resync")
		}
		time.Sleep(historyPollInterval)
	}
	exported := exportIndex(t, narsil)
	want := []string{"format", "version", "index", "epoch", "positions"}
	if len(exported.keys) != len(want) {
		t.Fatalf("the export header holds keys %v, while change capture needs %v", exported.keys, want)
	}
	for at := range want {
		if exported.keys[at] != want[at] {
			t.Fatalf("the export header holds keys %v, while change capture needs %v", exported.keys, want)
		}
	}
	if exported.epoch != behind.epoch || len(exported.positions) != 2 {
		t.Fatalf("the export holds epoch %s and positions %v, while the index holds epoch %s and 2 partitions",
			exported.epoch, exported.positions, behind.epoch)
	}
	if !reflectEqualDocuments(exported.documents, oracle.snapshot()) {
		t.Fatal("the export documents differ from the acknowledged writes")
	}
	resumed := subscriberOfExport(exported)
	writeTicketRound(t, narsil, oracle, 3)
	writeTicketRound(t, narsil, oracle, 4)
	tap := tapChanges(t, narsil, resumed.request())
	subscribed := tap.subscribed(t)
	if subscribed.Epoch != exported.epoch {
		t.Fatalf("the resumed subscription reports epoch %s, while the export holds %s", subscribed.Epoch, exported.epoch)
	}
	catchUpWithoutChecks(t, resumed, tap, oracle)
}

func TestAnExportTakenWhileWritersWriteAndTheEpochRenewsLeadsToEveryLaterChange(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), historySegmentBytes)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true})
	oracle := newWriteOracle()
	writeTicketRound(t, narsil, oracle, 0)
	var exported exportedIndex
	var writers sync.WaitGroup
	writers.Go(func() {
		for round := 1; round < 4; round++ {
			for slot := range followDocuments {
				id := "t" + strconv.Itoa(slot)
				document := ticket(id, round, "open")
				if err := narsil.Update(ctx, changesIndex, id, engine.DocumentFromMap(document),
					engine.WriteOptions{}); err == nil {
					oracle.record(id, document)
				} else if engine.ErrorCode(err) != engine.CodeDocNotFound {
					t.Errorf("a concurrent update failed with %s: %v", codeOrMessage(err), err)
				}
			}
		}
	})
	exported = exportIndex(t, narsil)
	writers.Wait()
	if t.Failed() {
		return
	}
	tap := tapChanges(t, narsil, subscriberOfExport(exported).request())
	resumed := subscriberOfExport(exported)
	tap.subscribed(t)
	catchUpWithoutChecks(t, resumed, tap, oracle)
	tap.stop()

	cleared := make(chan error, 1)
	go func() { cleared <- narsil.Clear(ctx, changesIndex) }()
	raced := exportIndex(t, narsil)
	if err := <-cleared; err != nil {
		t.Fatalf("the clear failed with %s: %v", codeOrMessage(err), err)
	}
	afterClear := newWriteOracle()
	afterClear.insert(t, narsil, "late", ticket("late", 9, "open"))
	status, err := narsil.GetChanges(ctx, changesIndex)
	if err != nil {
		t.Fatalf("reading the setting failed with %s: %v", codeOrMessage(err), err)
	}
	racedTap := tapChanges(t, narsil, subscriberOfExport(raced).request())
	if raced.epoch != status.Epoch {
		if reason := racedTap.resync(t); reason != engine.ResyncEpoch {
			t.Fatalf("an export from before the clear led to a resync for %q", reason)
		}
		return
	}
	if len(raced.documents) != 0 {
		t.Fatalf("an export under the epoch after the clear holds %d documents", len(raced.documents))
	}
	racedTap.subscribed(t)
	catchUpWithoutChecks(t, subscriberOfExport(raced), racedTap, afterClear)
}

func TestAnExportOfAnIndexWithoutCaptureHoldsNoPositionsAndImportIgnoresThem(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: false})
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "a", ticket("a", 0, "open"))
	plain := exportIndex(t, narsil)
	if len(plain.keys) != 3 || plain.epoch != "" || plain.positions != nil {
		t.Fatalf("an export without capture holds keys %v", plain.keys)
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, engine.ChangesSetting{Enabled: true}); err != nil {
		t.Fatalf("turning capture on failed with %s: %v", codeOrMessage(err), err)
	}
	var written bytes.Buffer
	if err := narsil.ExportDocuments(ctx, changesIndex, &written); err != nil {
		t.Fatalf("the export failed with %s: %v", codeOrMessage(err), err)
	}
	other := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = other.Shutdown(context.Background()) }()
	result, err := other.ImportDocumentExport(ctx, "copy", &written)
	if err != nil || len(result.Refused) != 0 {
		t.Fatalf("importing an export with positions gave %+v with error %s", result, codeOrMessage(err))
	}
	status, err := other.GetChanges(ctx, "copy")
	if err != nil || status.Enabled {
		t.Fatalf("an imported index reads %+v with error %s, while an import leaves capture off", status,
			codeOrMessage(err))
	}
	var archive bytes.Buffer
	if err := narsil.Snapshot(ctx, changesIndex, engine.SnapshotOptions{}, &archive); err != nil {
		t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	if err := other.Restore(ctx, "restored", &archive); err != nil {
		t.Fatalf("restoring onto another engine failed with %s: %v", codeOrMessage(err), err)
	}
	if restored, err := other.GetChanges(ctx, "restored"); err != nil || restored.Enabled {
		t.Fatalf("a snapshot restored onto another engine reads %+v with error %s", restored, codeOrMessage(err))
	}
	copied, found, err := other.Get(ctx, "copy", "a")
	imported := mapOf(copied)
	delete(imported, "id")
	if err != nil || !found || !jsonEqual(imported, oracle.snapshot()["a"]) {
		t.Fatalf("the imported document reads %v, found %v, error %v", mapOf(copied), found, err)
	}
}
