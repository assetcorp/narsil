package engine_test

import (
	"context"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	followPartitions = 3
	followDocuments  = 40
	followWriters    = 4
	followRounds     = 30
)

func writeTicketRound(t *testing.T, narsil *engine.Narsil, oracle *writeOracle, round int) {
	t.Helper()
	for slot := range followDocuments {
		id := "t" + strconv.Itoa(slot)
		_, held := oracle.snapshot()[id]
		switch {
		case !held:
			oracle.insert(t, narsil, id, ticket(id, round, "open"))
		case (slot+round)%7 == 0:
			oracle.remove(t, narsil, id)
		default:
			oracle.update(t, narsil, id, ticket(id, round, []string{"open", "closed"}[(slot+round)%2]))
		}
	}
}

func TestChangesDeliverEveryAcknowledgedWriteWithThePreviousDocumentAcrossCheckpointsAndRestarts(t *testing.T) {
	directory := t.TempDir()
	narsil := openChangesEngine(t, directory, 0)
	createChangesIndex(t, narsil, followPartitions, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	ctx := context.Background()
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	subscribed := tap.subscribed(t)
	if subscribed.PartitionCount != followPartitions || len(subscribed.Positions) != followPartitions ||
		!subscribed.PreviousDocument || subscribed.BytesBehind != 0 {
		t.Fatalf("a subscription from the heads reported %+v", subscribed)
	}
	reader := newSubscriber(subscribed)
	oracle := newWriteOracle()
	for round := range 4 {
		writeTicketRound(t, narsil, oracle, round)
		if err := narsil.Checkpoint(ctx, changesIndex); err != nil {
			t.Fatalf("checkpoint %d failed with %s: %v", round, codeOrMessage(err), err)
		}
	}
	reader.catchUp(t, tap, oracle)
	tap.quiet(t)
	tap.stop()
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the shutdown failed with %s: %v", codeOrMessage(err), err)
	}

	reopened := openChangesEngine(t, directory, 0)
	defer func() { _ = reopened.Shutdown(context.Background()) }()
	status, err := reopened.GetChanges(ctx, changesIndex)
	if err != nil || !status.Enabled || !status.PreviousDocument || status.Epoch != reader.epoch {
		t.Fatalf("after the restart the setting reads %+v with error %s, while the epoch was %s", status,
			codeOrMessage(err), reader.epoch)
	}
	writeTicketRound(t, reopened, oracle, 4)
	resumed := tapChanges(t, reopened, reader.request())
	again := resumed.subscribed(t)
	for partitionID, position := range again.Positions {
		if position.SeqNo != reader.positions[partitionID] {
			t.Fatalf("the resumed subscription starts partition %d at %d, while the saved position was %d", partitionID,
				position.SeqNo, reader.positions[partitionID])
		}
	}
	if again.BytesBehind == 0 {
		t.Fatal("the resumed subscription reports no bytes behind, while a round of writes waits for it")
	}
	reader.catchUp(t, resumed, oracle)

	replay := tapChanges(t, reopened, engine.ChangesRequest{Epoch: engine.Some(reader.epoch),
		Positions: make([]engine.ChangePosition, 0)})
	if failure := replay.failure(t); engine.ErrorCode(failure) != engine.CodeChangesInvalidPositions {
		t.Fatalf("an empty list of positions failed with %s", codeOrMessage(failure))
	}
	zero := make([]engine.ChangePosition, followPartitions)
	for partitionID := range zero {
		zero[partitionID].PartitionID = uint32(partitionID)
	}
	fromStart := tapChanges(t, reopened, engine.ChangesRequest{Epoch: engine.Some(reader.epoch), Positions: zero})
	fresh := newSubscriber(fromStart.subscribed(t))
	fresh.catchUp(t, fromStart, oracle)
}

func TestChangesOfConcurrentWritersMatchTheAcknowledgedWrites(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 4096)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	createChangesIndex(t, narsil, followPartitions, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	reader := newSubscriber(tap.subscribed(t))
	oracle := newWriteOracle()
	failures := make([]error, followWriters)
	var group sync.WaitGroup
	for writer := range followWriters {
		group.Go(func() {
			ctx := context.Background()
			for round := range followRounds {
				id := "w" + strconv.Itoa(writer) + "-" + strconv.Itoa(round%5)
				document := ticket(id, round, "open")
				var err error
				if round < 5 {
					_, err = narsil.Insert(ctx, changesIndex, engine.DocumentFromMap(document), id, engine.InsertOptions{})
				} else {
					err = narsil.Update(ctx, changesIndex, id, engine.DocumentFromMap(document), engine.WriteOptions{})
				}
				if err != nil {
					failures[writer] = err
					return
				}
				oracle.record(id, document)
				if round%10 == 9 {
					if err := narsil.Checkpoint(ctx, changesIndex); err != nil {
						failures[writer] = err
						return
					}
				}
			}
		})
	}
	var received []*engine.ChangeGroup
	writersDone := make(chan struct{})
	go func() {
		group.Wait()
		close(writersDone)
	}()
	for waiting := true; waiting; {
		select {
		case event := <-tap.events:
			if event.err != nil || event.event.Group == nil {
				t.Fatalf("while writers wrote the iteration sent %+v with error %s", event.event, codeOrMessage(event.err))
			}
			received = append(received, event.event.Group)
		case <-writersDone:
			waiting = false
		}
	}
	for writer, err := range failures {
		if err != nil {
			t.Fatalf("writer %d failed with %s: %v", writer, codeOrMessage(err), err)
		}
	}
	for _, changes := range received {
		reader.apply(t, changes, oracle)
	}
	reader.catchUp(t, tap, oracle)
}

func TestAWaitingReaderLeavesAClosedIndexClosedAndResumesAfterAWriteReopensIt(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	ctx := context.Background()
	createChangesIndex(t, narsil, 2, engine.ChangesSetting{Enabled: true, PreviousDocument: true})
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	reader := newSubscriber(tap.subscribed(t))
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "a", ticket("a", 0, "open"))
	reader.catchUp(t, tap, oracle)
	if err := narsil.Close(ctx, changesIndex); err != nil {
		t.Fatalf("closing the index failed with %s: %v", codeOrMessage(err), err)
	}
	time.Sleep(3 * changesQuietPeriod)
	tap.quiet(t)
	for _, info := range narsil.ListIndexes() {
		if info.Name == changesIndex && info.State != engine.IndexClosed {
			t.Fatalf("a waiting reader left the closed index in state %q", info.State)
		}
	}
	oracle.update(t, narsil, "a", ticket("a", 1, "closed"))
	oracle.insert(t, narsil, "b", ticket("b", 0, "open"))
	reader.catchUp(t, tap, oracle)
}

func TestChangesWithoutThePreviousDocumentReportPutsAndBareRemovals(t *testing.T) {
	narsil := openChangesEngine(t, t.TempDir(), 0)
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	createChangesIndex(t, narsil, 1, engine.ChangesSetting{Enabled: true})
	tap := tapChanges(t, narsil, engine.ChangesRequest{})
	subscribed := tap.subscribed(t)
	if subscribed.PreviousDocument {
		t.Fatal("the subscription reports previous documents on an index that records none")
	}
	reader := newSubscriber(subscribed)
	oracle := newWriteOracle()
	oracle.insert(t, narsil, "a", ticket("a", 0, "open"))
	oracle.update(t, narsil, "a", ticket("a", 1, "open"))
	oracle.remove(t, narsil, "a")
	oracle.insert(t, narsil, "b", ticket("b", 0, "closed"))
	types := map[string][]engine.ChangeType{}
	for received := 0; received < 4; {
		event := tap.next(t)
		if event.err != nil || event.event.Group == nil {
			t.Fatalf("the iteration sent %+v with error %s", event.event, codeOrMessage(event.err))
		}
		for _, change := range event.event.Group.Changes {
			if change.PreviousDocument != nil {
				t.Fatalf("change %d holds a previous document on an index that records none", change.SeqNo)
			}
			types[change.DocumentID] = append(types[change.DocumentID], change.Type)
			received++
		}
		reader.apply(t, event.event.Group, nil)
	}
	want := map[string][]engine.ChangeType{"a": {engine.ChangePut, engine.ChangePut, engine.ChangeRemove},
		"b": {engine.ChangePut}}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("the changes have types %v, while the writes give %v", types, want)
	}
	reader.requireMatches(t, oracle.snapshot())
}
