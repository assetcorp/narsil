package engine_test

import (
	"context"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestWriteListenersCanCloseTheirIndex(t *testing.T) {
	scenario := os.Getenv("NARSIL_WRITE_LISTENER_CHILD")
	if scenario == "" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, event := range []string{"write", "watermark", "promotion"} {
			t.Run(event, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				child := exec.CommandContext(ctx, executable, "-test.run=^TestWriteListenersCanCloseTheirIndex$")
				child.Env = append(os.Environ(), "NARSIL_WRITE_LISTENER_CHILD="+event)
				if output, err := child.CombinedOutput(); err != nil {
					t.Fatalf("the listener failed or deadlocked: %v\n%s", err, output)
				}
			})
		}
		return
	}
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{
		Workers:    engine.WorkerConfig{Enabled: engine.Some(true), Count: engine.Some(1), PromotionThreshold: engine.Some(1)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDown(t, narsil, "after the write listener")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema:     engine.Schema{"title": engine.FieldString},
		Partitions: engine.PartitionConfig{MaxDocsPerPartition: engine.Some(1), Watermark: engine.Some(0.5)},
	}); err != nil {
		t.Fatal(err)
	}
	var called atomic.Bool
	var callbackErr error
	closeIndex := func() {
		if !called.Swap(true) {
			callbackErr = narsil.Close(ctx, callbackIndex)
		}
	}
	handlers := engine.EventHandlers{}
	switch scenario {
	case "write":
		handlers.Write = func(engine.WriteEvent) { closeIndex() }
	case "watermark":
		handlers.PartitionWatermark = func(engine.PartitionWatermarkEvent) { closeIndex() }
	case "promotion":
		handlers.WorkerPromote = func(engine.WorkerPromoteEvent) { closeIndex() }
	}
	unlisten := narsil.On(handlers)
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	unlisten()
	if !called.Load() || callbackErr != nil {
		t.Fatalf("listener called=%t, error=%v", called.Load(), callbackErr)
	}
	result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "lighthouse"})
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
		t.Fatalf("the reopened index returned %+v, %v", result, err)
	}
}
