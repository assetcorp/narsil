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

type checkpointValueContext struct {
	context.Context
	armed atomic.Bool
	act   func()
}

func (c *checkpointValueContext) Done() <-chan struct{} {
	c.armed.Store(true)
	return c.Context.Done()
}

func (c *checkpointValueContext) Value(key any) any {
	if c.armed.Swap(false) {
		c.act()
	}
	return c.Context.Value(key)
}

func (c *checkpointValueContext) Err() error {
	panic("the search called the caller's Err method")
}

func TestCancellableContextValueCanCheckpoint(t *testing.T) {
	if os.Getenv("NARSIL_CONTEXT_VALUE_CHILD") == "" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		child := exec.CommandContext(ctx, executable, "-test.run=^TestCancellableContextValueCanCheckpoint$")
		child.Env = append(os.Environ(), "NARSIL_CONTEXT_VALUE_CHILD=1")
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("the context callback failed or deadlocked: %v\n%s", err, output)
		}
		return
	}
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{
		Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDown(t, narsil, "after the context value callback")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	parent, cancel := context.WithCancel(ctx)
	defer cancel()
	caller := &checkpointValueContext{Context: parent, act: func() {
		if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "harbour"), "added", engine.InsertOptions{}); err != nil {
			t.Fatal(err)
		}
		if err := narsil.Checkpoint(ctx, callbackIndex); err != nil {
			t.Fatal(err)
		}
	}}
	result, err := narsil.Query(caller, callbackIndex, engine.QueryParams{Term: `"lighthouse"`})
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
		t.Fatalf("the search returned %+v, %v", result, err)
	}
}
