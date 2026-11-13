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
	changesIndex         = "tickets"
	changesEventWait     = 20 * time.Second
	changesQuietPeriod   = 300 * time.Millisecond
	changesMaxPartitions = 8
)

func openChangesEngine(t *testing.T, directory string, segmentMaxBytes int64) *engine.Narsil {
	t.Helper()
	durability := &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}
	if segmentMaxBytes > 0 {
		durability.SegmentMaxBytes = engine.Some(segmentMaxBytes)
	}
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: durability})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func ticketSchema() engine.Schema {
	return engine.Schema{"title": engine.FieldString, "status": engine.FieldEnum, "rank": engine.FieldNumber,
		"embedding": engine.VectorFieldType(3)}
}

func createChangesIndex(t *testing.T, narsil *engine.Narsil, partitions int, setting engine.ChangesSetting) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, changesIndex, engine.IndexConfig{Schema: ticketSchema(), Language: "english",
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(changesMaxPartitions)}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	if partitions > 1 {
		if err := narsil.Rebalance(ctx, changesIndex, partitions); err != nil {
			t.Fatalf("the rebalance to %d partitions failed with %s: %v", partitions, codeOrMessage(err), err)
		}
	}
	if err := narsil.UpdateChanges(ctx, changesIndex, setting); err != nil {
		t.Fatalf("turning change capture on failed with %s: %v", codeOrMessage(err), err)
	}
}

func ticket(id string, version int, status string) map[string]any {
	return map[string]any{"title": "ticket " + id + " revision " + strconv.Itoa(version), "status": status,
		"rank": float64(version), "embedding": []float32{float32(version), 1, float32(len(id))}}
}

type transition struct {
	before map[string]any
	after  map[string]any
}

type writeOracle struct {
	mu          sync.Mutex
	documents   map[string]map[string]any
	transitions map[string][]transition
}

func newWriteOracle() *writeOracle {
	return &writeOracle{documents: map[string]map[string]any{}, transitions: map[string][]transition{}}
}

func (oracle *writeOracle) record(id string, after map[string]any) {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	before := oracle.documents[id]
	if after == nil {
		delete(oracle.documents, id)
	} else {
		oracle.documents[id] = after
	}
	oracle.transitions[id] = append(oracle.transitions[id], transition{before: before, after: after})
}

func (oracle *writeOracle) snapshot() map[string]map[string]any {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	copied := make(map[string]map[string]any, len(oracle.documents))
	for id, document := range oracle.documents {
		copied[id] = document
	}
	return copied
}

func (oracle *writeOracle) forget() {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	oracle.transitions = map[string][]transition{}
}

func (oracle *writeOracle) insert(t *testing.T, narsil *engine.Narsil, id string, document map[string]any) {
	t.Helper()
	if _, err := narsil.Insert(context.Background(), changesIndex, engine.DocumentFromMap(document), id,
		engine.InsertOptions{}); err != nil {
		t.Fatalf("the insert of %s failed with %s: %v", id, codeOrMessage(err), err)
	}
	oracle.record(id, document)
}

func (oracle *writeOracle) insertBatch(t *testing.T, narsil *engine.Narsil, ids []string, documents []map[string]any) {
	t.Helper()
	batch := make([]*engine.Document, 0, len(ids))
	for at, id := range ids {
		identified := map[string]any{"id": id}
		for field, value := range documents[at] {
			identified[field] = value
		}
		batch = append(batch, engine.DocumentFromMap(identified))
	}
	result, err := narsil.InsertBatch(context.Background(), changesIndex, batch, engine.InsertOptions{})
	if err != nil || len(result.Failed) > 0 {
		t.Fatalf("the batch insert of %d documents failed with %s: %v, refusing %d", len(ids), codeOrMessage(err), err,
			len(result.Failed))
	}
	for at, id := range ids {
		oracle.record(id, documents[at])
	}
}

func (oracle *writeOracle) update(t *testing.T, narsil *engine.Narsil, id string, document map[string]any) {
	t.Helper()
	if err := narsil.Update(context.Background(), changesIndex, id, engine.DocumentFromMap(document),
		engine.WriteOptions{}); err != nil {
		t.Fatalf("the update of %s failed with %s: %v", id, codeOrMessage(err), err)
	}
	oracle.record(id, document)
}

func (oracle *writeOracle) remove(t *testing.T, narsil *engine.Narsil, id string) {
	t.Helper()
	if err := narsil.Remove(context.Background(), changesIndex, id, engine.WriteOptions{}); err != nil {
		t.Fatalf("the removal of %s failed with %s: %v", id, codeOrMessage(err), err)
	}
	oracle.record(id, nil)
}

type tapEvent struct {
	event engine.ChangesEvent
	err   error
}

type changesTap struct {
	events chan tapEvent
	cancel context.CancelFunc
	done   chan struct{}
}

func tapChanges(t *testing.T, narsil *engine.Narsil, request engine.ChangesRequest) *changesTap {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	tap := &changesTap{events: make(chan tapEvent), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(tap.done)
		for event, err := range narsil.Changes(ctx, changesIndex, request) {
			select {
			case tap.events <- tapEvent{event: event, err: err}:
			case <-ctx.Done():
				return
			}
		}
	}()
	t.Cleanup(tap.stop)
	return tap
}

func (tap *changesTap) stop() {
	tap.cancel()
	<-tap.done
}

func (tap *changesTap) next(t *testing.T) tapEvent {
	t.Helper()
	select {
	case received := <-tap.events:
		return received
	case <-tap.done:
		t.Fatal("the changes iteration ended without another event")
	case <-time.After(changesEventWait):
		t.Fatal("the changes iteration sent no event in time")
	}
	return tapEvent{}
}

func (tap *changesTap) quiet(t *testing.T) {
	t.Helper()
	select {
	case received := <-tap.events:
		t.Fatalf("the changes iteration sent an event with no write behind it: %+v, error %v", received.event, received.err)
	case <-time.After(changesQuietPeriod):
	}
}

func (tap *changesTap) subscribed(t *testing.T) *engine.ChangesSubscribed {
	t.Helper()
	received := tap.next(t)
	if received.err != nil || received.event.Subscribed == nil {
		t.Fatalf("the first event is not a subscription: %+v, error %s", received.event, codeOrMessage(received.err))
	}
	return received.event.Subscribed
}

func (tap *changesTap) failure(t *testing.T) error {
	t.Helper()
	for {
		received := tap.next(t)
		if received.err != nil {
			return received.err
		}
		if received.event.Resync != nil {
			t.Fatalf("the iteration ended with a resync for %q in place of an error", received.event.Resync.Reason)
		}
	}
}

func (tap *changesTap) resync(t *testing.T) engine.ResyncReason {
	t.Helper()
	for {
		received := tap.next(t)
		if received.err != nil {
			t.Fatalf("the iteration failed with %s in place of a resync: %v", codeOrMessage(received.err), received.err)
		}
		if received.event.Resync != nil {
			return received.event.Resync.Reason
		}
	}
}

type subscriber struct {
	epoch     string
	positions []uint64
	documents map[string]map[string]any
	applied   map[string]int
}

func newSubscriber(subscribed *engine.ChangesSubscribed) *subscriber {
	positions := make([]uint64, subscribed.PartitionCount)
	for _, position := range subscribed.Positions {
		positions[position.PartitionID] = position.SeqNo
	}
	return &subscriber{epoch: subscribed.Epoch, positions: positions, documents: map[string]map[string]any{},
		applied: map[string]int{}}
}

func (reader *subscriber) request() engine.ChangesRequest {
	positions := make([]engine.ChangePosition, len(reader.positions))
	for partitionID, seqNo := range reader.positions {
		positions[partitionID] = engine.ChangePosition{PartitionID: uint32(partitionID), SeqNo: seqNo}
	}
	return engine.ChangesRequest{Epoch: engine.Some(reader.epoch), Positions: positions}
}

func mapOf(document *engine.Document) map[string]any {
	if document == nil {
		return nil
	}
	return document.Map()
}

func (reader *subscriber) apply(t *testing.T, group *engine.ChangeGroup, oracle *writeOracle) {
	t.Helper()
	partition := group.PartitionID
	last := reader.positions[partition]
	for _, change := range group.Changes {
		if change.SeqNo <= last || change.SeqNo > group.ScannedSeqNo {
			t.Fatalf("partition %d sent seqNo %d after position %d with scannedSeqNo %d", partition, change.SeqNo, last,
				group.ScannedSeqNo)
		}
		last = change.SeqNo
		if oracle != nil {
			reader.check(t, change, oracle)
		}
		if change.Type == engine.ChangeRemove {
			delete(reader.documents, change.DocumentID)
			continue
		}
		reader.documents[change.DocumentID] = mapOf(change.Document)
	}
	if group.ScannedSeqNo < reader.positions[partition] {
		t.Fatalf("partition %d moved its position back from %d to %d", partition, reader.positions[partition],
			group.ScannedSeqNo)
	}
	reader.positions[partition] = group.ScannedSeqNo
}

func (reader *subscriber) check(t *testing.T, change engine.Change, oracle *writeOracle) {
	t.Helper()
	oracle.mu.Lock()
	queue := oracle.transitions[change.DocumentID]
	at := reader.applied[change.DocumentID]
	oracle.mu.Unlock()
	if at >= len(queue) {
		t.Fatalf("change %d of %s has no acknowledged write behind it", change.SeqNo, change.DocumentID)
	}
	expected := queue[at]
	reader.applied[change.DocumentID] = at + 1
	wantType := engine.ChangeUpdate
	switch {
	case expected.after == nil:
		wantType = engine.ChangeRemove
	case expected.before == nil:
		wantType = engine.ChangeInsert
	}
	if change.Type != wantType {
		t.Fatalf("change %d of %s has type %q, while the write was a %q", change.SeqNo, change.DocumentID, change.Type,
			wantType)
	}
	if got := mapOf(change.Document); !reflect.DeepEqual(got, expected.after) {
		t.Fatalf("change %d of %s holds document %v, while the write stored %v", change.SeqNo, change.DocumentID, got,
			expected.after)
	}
	if got := mapOf(change.PreviousDocument); !reflect.DeepEqual(got, expected.before) {
		t.Fatalf("change %d of %s holds previous document %v, while the index held %v", change.SeqNo, change.DocumentID,
			got, expected.before)
	}
}

func (oracle *writeOracle) pending(reader *subscriber) int {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	waiting := 0
	for id, queue := range oracle.transitions {
		waiting += len(queue) - reader.applied[id]
	}
	return waiting
}

func (reader *subscriber) catchUp(t *testing.T, tap *changesTap, oracle *writeOracle) {
	t.Helper()
	for oracle.pending(reader) > 0 {
		received := tap.next(t)
		if received.err != nil || received.event.Group == nil {
			t.Fatalf("while catching up the iteration sent %+v with error %s", received.event, codeOrMessage(received.err))
		}
		reader.apply(t, received.event.Group, oracle)
	}
	reader.requireMatches(t, oracle.snapshot())
}

func (reader *subscriber) requireMatches(t *testing.T, expected map[string]map[string]any) {
	t.Helper()
	if len(reader.documents) != len(expected) {
		t.Fatalf("the subscriber holds %d documents, while the acknowledged writes leave %d", len(reader.documents),
			len(expected))
	}
	for id, document := range expected {
		if held := reader.documents[id]; !reflect.DeepEqual(held, document) {
			t.Fatalf("the subscriber holds %v for %s, while the acknowledged writes leave %v", held, id, document)
		}
	}
}
