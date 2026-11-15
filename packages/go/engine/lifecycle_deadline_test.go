package engine_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type pausedArchiveWriter struct {
	once    sync.Once
	entered chan struct{}
	proceed chan struct{}
}

func (w *pausedArchiveWriter) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.proceed })
	return io.Discard.Write(data)
}

func TestLifecycleCallsBesideAStreamingSnapshotKeepItWhole(t *testing.T) {
	waitsForTheArchive := map[string]bool{"close": false, "drop": true, "restore": true}
	for operation, waits := range waitsForTheArchive {
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
				t.Fatalf("the %s waited beyond its deadline for the snapshot", operation)
			}
			if waits && !errors.Is(failure, context.DeadlineExceeded) || !waits && failure != nil {
				t.Fatalf("the %s returned %v", operation, failure)
			}
			result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "lighthouse"})
			if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "kept" {
				t.Fatalf("after the %s the index returned %+v, %v", operation, result, err)
			}
		})
	}
}
