package engine_test

import (
	"context"
	"fmt"
	"runtime/debug"
	"runtime/metrics"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	growthSeedDocuments  = 32_736
	growthSeedBatch      = 256
	growthHeadroomBytes  = 1536 << 10
	growthHeapLimitBytes = 1 << 30
	growthRefreshPause   = 20 * time.Millisecond
)

func growthHeapBytes() uint64 {
	samples := []metrics.Sample{{Name: "/memory/classes/total:bytes"}, {Name: "/memory/classes/heap/released:bytes"}}
	metrics.Read(samples)
	return samples[0].Value.Uint64() - samples[1].Value.Uint64()
}

func seedGrowthPartitions(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	ctx := context.Background()
	for start := 0; start < growthSeedDocuments; start += growthSeedBatch {
		documents := make([]*engine.Document, min(growthSeedBatch, growthSeedDocuments-start))
		for at := range documents {
			documents[at] = engine.NewDocument().Set("id", fmt.Sprintf("seed-%05d", start+at)).Set("value", float64(at))
		}
		result, err := narsil.InsertBatch(ctx, memoryIndexName, documents, engine.InsertOptions{})
		if err != nil || len(result.Succeeded) != len(documents) || len(result.Failed) > 0 {
			t.Fatalf("seeding the partitions failed: %v, %+v", err, result.Failed)
		}
	}
	stats, err := narsil.GetPartitionStats(memoryIndexName)
	if err != nil || len(stats) != 2 {
		t.Fatalf("reading the partitions failed: %v, %+v", err, stats)
	}
	for _, partition := range stats {
		if partition.DocumentCount != growthSeedDocuments/2 {
			t.Fatalf("the seed documents did not divide equally: %+v", stats)
		}
	}
}

func TestMemoryBlockCountsGrowthAfterAnEarlierWritePublishes(t *testing.T) {
	if !memoryAttackChild(t, growthHeapLimitBytes) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), memoryChildDeadline)
	defer cancel()
	held := make(chan struct{})
	released := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(released) }) }
	plugin := engine.Plugin{Name: "hold-published-write", AfterInsert: func(ctx context.Context, insert *engine.InsertContext) error {
		if insert.DocID == "fresh-0" {
			close(held)
			select {
			case <-released:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}}
	narsil, err := engine.New(ctx, engine.Config{Plugins: []engine.Plugin{plugin},
		Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { unblock(); _ = narsil.Shutdown(context.Background()) }()
	createSpreadIndex(t, narsil, memoryIndexName, engine.Schema{"value": engine.FieldNumber,
		"embedding": engine.VectorFieldType(1)}, 2)
	seedGrowthPartitions(t, narsil)
	debug.FreeOSMemory()
	blockBytes := growthHeapBytes() + growthHeadroomBytes
	previousLimit := debug.SetMemoryLimit(int64(float64(blockBytes) / memoryDefaultBlock))
	defer debug.SetMemoryLimit(previousLimit)
	time.Sleep(growthRefreshPause)
	finished := make(chan error, 1)
	go func() {
		_, err := narsil.Insert(ctx, memoryIndexName, engine.NewDocument().Set("value", float64(1)), "fresh-0", engine.InsertOptions{})
		finished <- err
	}()
	select {
	case <-held:
	case err := <-finished:
		t.Fatalf("the first growth must fit: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err = narsil.Insert(ctx, memoryIndexName, engine.NewDocument().Set("value", float64(2)), "fresh-1", engine.InsertOptions{})
	if engine.ErrorCode(err) != engine.CodeMemoryWriteBlocked {
		t.Fatalf("the second partition growth returned %v with %d heap bytes against a %d-byte block", err,
			growthHeapBytes(), blockBytes)
	}
	unblock()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	count, err := narsil.CountDocuments(ctx, memoryIndexName)
	if err != nil || count != growthSeedDocuments+1 {
		t.Fatalf("the index must retain only the first new document: count %d, %v", count, err)
	}
	for id, expected := range map[string]bool{"fresh-0": true, "fresh-1": false} {
		document, found, err := narsil.Get(ctx, memoryIndexName, id)
		if err != nil || found != expected {
			t.Fatalf("reading %s returned found %v, expected %v: %v", id, found, expected, err)
		}
		if found {
			if value, _ := document.Get("value"); value != float64(1) {
				t.Fatalf("the accepted document holds value %v", value)
			}
		}
	}
}
