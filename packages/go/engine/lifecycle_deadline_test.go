package engine_test

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type pausedArchiveWriter struct {
	bytes.Buffer
	once    sync.Once
	entered chan struct{}
	proceed chan struct{}
}

func (w *pausedArchiveWriter) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.proceed })
	return w.Buffer.Write(data)
}

func TestLifecycleCallsBesideAStreamingSnapshotKeepItWhole(t *testing.T) {
	for _, operation := range []string{"close", "drop", "restore"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			narsil := startedForCallbacks(t, true)
			if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
				t.Fatal(err)
			}
			if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
				t.Fatal(err)
			}
			archive := snapshotOf(t, narsil, callbackIndex)
			writer := &pausedArchiveWriter{entered: make(chan struct{}), proceed: make(chan struct{})}
			snapshotDone := make(chan error, 1)
			go func() { snapshotDone <- narsil.Snapshot(ctx, callbackIndex, engine.SnapshotOptions{}, writer) }()
			<-writer.entered
			bounded, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
			defer cancel()
			finished := make(chan error, 1)
			go func() {
				switch operation {
				case "close":
					finished <- narsil.Close(bounded, callbackIndex)
				case "drop":
					finished <- narsil.DropIndex(bounded, callbackIndex)
				case "restore":
					finished <- narsil.Restore(bounded, callbackIndex, bytes.NewReader(archive))
				}
			}()
			returned := false
			var failure error
			select {
			case failure = <-finished:
				returned = true
			case <-time.After(time.Second):
			}
			close(writer.proceed)
			if err := <-snapshotDone; err != nil {
				t.Fatal(err)
			}
			if !returned {
				<-finished
				t.Fatalf("the %s waited for the snapshot", operation)
			}
			if failure != nil {
				t.Fatalf("the %s returned %v", operation, failure)
			}
			reader := startedForCallbacks(t, false)
			if err := restoreArchive(reader, callbackIndex, writer.Bytes()); err != nil {
				t.Fatalf("restoring the snapshot taken beside the %s failed with %s: %v", operation, codeOrMessage(err), err)
			}
			if err := onlyLighthouse(reader, ctx, callbackIndex); err != nil {
				t.Fatalf("the snapshot taken beside the %s: %v", operation, err)
			}
			if operation == "drop" {
				if listed := narsil.ListIndexes(); len(listed) != 0 {
					t.Fatalf("after the drop the engine lists %+v", listed)
				}
				return
			}
			if err := onlyLighthouse(narsil, ctx, callbackIndex); err != nil {
				t.Fatalf("after the %s: %v", operation, err)
			}
		})
	}
}
