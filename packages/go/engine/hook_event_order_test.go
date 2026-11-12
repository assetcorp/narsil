package engine_test

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	orderedIndex               = "ordered"
	orderedMaxDocsPerPartition = 10
	orderedWatermarkFraction   = 0.2
	orderedPartitions          = 2
	orderedRebalanceTarget     = 1
)

var orderedIDs = []string{"d1", "d2", "d3", "d4"}

type orderLog struct {
	mu      sync.Mutex
	entries []string
}

func (log *orderLog) add(format string, args ...any) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.entries = append(log.entries, fmt.Sprintf(format, args...))
}

func (log *orderLog) take() []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	taken := log.entries
	log.entries = nil
	return taken
}

func startedRecordingOrder(t *testing.T) (*engine.Narsil, *orderLog) {
	t.Helper()
	log := &orderLog{}
	plugin := engine.Plugin{
		Name: "recording-order",
		BeforeInsert: func(_ context.Context, insert *engine.InsertContext) error {
			log.add("beforeInsert %s", insert.DocID)
			return nil
		},
		AfterInsert: func(_ context.Context, insert *engine.InsertContext) error {
			log.add("afterInsert %s", insert.DocID)
			return nil
		},
		OnPartitionSplit: func(_ context.Context, split *engine.PartitionContext) error {
			log.add("onPartitionSplit %d to %d", split.OldPartitionCount, split.NewPartitionCount)
			return nil
		},
	}
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}, Plugins: []engine.Plugin{plugin}}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), callbackShutdownWait)
		defer cancel()
		_ = narsil.Shutdown(ctx)
	})
	narsil.On(engine.EventHandlers{
		PartitionWatermark: func(event engine.PartitionWatermarkEvent) {
			log.add("watermark %d of %d", event.DocumentCount, event.Capacity)
		},
		PartitionRebalance: func(event engine.PartitionRebalanceEvent) {
			log.add("rebalance %d to %d", event.OldCount, event.NewCount)
		},
	})
	indexConfig := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(orderedPartitions),
			MaxDocsPerPartition: engine.Some(orderedMaxDocsPerPartition), Watermark: engine.Some(orderedWatermarkFraction)}}
	if err := narsil.CreateIndex(context.Background(), orderedIndex, indexConfig); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	return narsil, log
}

func requireOrder(t *testing.T, found []string, wanted []string) {
	t.Helper()
	if !slices.Equal(found, wanted) {
		t.Fatalf("the hooks and events ran in the order %q, while the oracle expects %q", found, wanted)
	}
}

func insertOrdered(t *testing.T, narsil *engine.Narsil, ids []string) {
	t.Helper()
	documents := make([]*engine.Document, len(ids))
	for at, id := range ids {
		documents[at] = identifiedNote(id, "ordered note")
	}
	if err := requireWholeBatch(narsil.InsertBatch(context.Background(), orderedIndex, documents, engine.InsertOptions{})); err != nil {
		t.Fatalf("the batch failed with %s: %v", codeOrMessage(err), err)
	}
}

func TestTheWatermarkCheckFollowsTheHooksOfASingleInsert(t *testing.T) {
	narsil, log := startedRecordingOrder(t)
	for _, id := range orderedIDs {
		if _, err := narsil.Insert(context.Background(), orderedIndex, noteDocument("ordered note"), id,
			engine.InsertOptions{}); err != nil {
			t.Fatalf("the insert of %s failed with %s: %v", id, codeOrMessage(err), err)
		}
	}
	requireOrder(t, log.take(), []string{
		"beforeInsert d1", "afterInsert d1", "beforeInsert d2", "afterInsert d2",
		"beforeInsert d3", "afterInsert d3", "beforeInsert d4", "afterInsert d4", "watermark 4 of 20",
	})
}

func TestTheWatermarkCheckFollowsEveryAfterHookOfABatch(t *testing.T) {
	narsil, log := startedRecordingOrder(t)
	insertOrdered(t, narsil, orderedIDs)
	requireOrder(t, log.take(), []string{
		"beforeInsert d1", "beforeInsert d2", "beforeInsert d3", "beforeInsert d4",
		"afterInsert d1", "afterInsert d2", "afterInsert d3", "afterInsert d4", "watermark 4 of 20",
	})
}

func TestTheWatermarkCheckFollowsTheSplitHookOfARebalance(t *testing.T) {
	narsil, log := startedRecordingOrder(t)
	insertOrdered(t, narsil, orderedIDs[:3])
	log.take()
	if err := narsil.Rebalance(context.Background(), orderedIndex, orderedRebalanceTarget); err != nil {
		t.Fatalf("the rebalance failed with %s: %v", codeOrMessage(err), err)
	}
	requireOrder(t, log.take(), []string{"rebalance 2 to 1", "onPartitionSplit 2 to 1", "watermark 3 of 10"})
}
