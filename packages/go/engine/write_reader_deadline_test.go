package engine_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

func TestAWriteDeadlineEndsTheWaitForAnEarlierReader(t *testing.T) {
	t.Run("update", func(t *testing.T) { writeDeadlineBehindReader(t, false) })
	t.Run("clear", func(t *testing.T) { writeDeadlineBehindReader(t, true) })
}

func writeDeadlineBehindReader(t *testing.T, clear bool) {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDownWithin(t, narsil, "after the reader deadline")
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(2)},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "harbour"), "kept",
		engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 1_000_000)
	for at := range ids {
		ids[at] = "kept"
	}
	reading, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	read := make(chan error, 1)
	go func() {
		_, err := narsil.GetMultiple(reading, callbackIndex, ids)
		read <- err
	}()
	time.Sleep(50 * time.Millisecond)
	if err := narsil.Update(ctx, callbackIndex, "kept", engine.NewDocument().Set("title", "pier"),
		engine.WriteOptions{}); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	written := make(chan error, 1)
	go func() {
		if clear {
			written <- narsil.Clear(bounded, callbackIndex)
			return
		}
		written <- narsil.Update(bounded, callbackIndex, "kept", engine.NewDocument().Set("title", "lighthouse"),
			engine.WriteOptions{})
	}()
	select {
	case err = <-written:
	case <-time.After(time.Second):
		cancelRead()
		err = <-written
		t.Fatalf("the write outlived its deadline while a reader held the old version: %v", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the waiting write returned %v, expected context.DeadlineExceeded", err)
	}
	cancelRead()
	if err := <-read; !errors.Is(err, context.Canceled) {
		t.Fatalf("the earlier read ended before cancellation: %v", err)
	}
	document, found, err := narsil.Get(ctx, callbackIndex, "kept")
	if err != nil || !found {
		t.Fatalf("the kept document is missing: %v", err)
	}
	if title, _ := document.Get("title"); title != "pier" {
		t.Fatalf("the expired write changed the document to %v", title)
	}
}
