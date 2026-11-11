package engine_test

import (
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	busyCheckpointIndex             = "ledger"
	busyCheckpointWriters           = 4
	busyCheckpointDocumentsPerWrite = 25
	busyCheckpointAttempts          = 300
	busyCheckpointLimit             = 20 * time.Second
)

func openBusyCheckpointEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

type busyWriter struct {
	versions map[string]string
	failure  error
}

func busyTitle(id string, version int) string {
	return "entry " + id + " version " + strconv.Itoa(version)
}

func rewriteUntilStopped(narsil *engine.Narsil, writer int, stopped *atomic.Bool, into *busyWriter) {
	ctx := context.Background()
	into.versions = map[string]string{}
	for version := 0; !stopped.Load() || version == 0; version++ {
		for slot := range busyCheckpointDocumentsPerWrite {
			id := "w" + strconv.Itoa(writer) + "-" + strconv.Itoa(slot)
			title := busyTitle(id, version)
			document := engine.DocumentFromMap(map[string]any{"title": title})
			var err error
			if version == 0 {
				_, err = narsil.Insert(ctx, busyCheckpointIndex, document, id, engine.InsertOptions{})
			} else {
				err = narsil.Update(ctx, busyCheckpointIndex, id, document, engine.WriteOptions{})
			}
			if err != nil {
				into.failure = err
				return
			}
			into.versions[id] = title
		}
	}
}

func checkpointWhileWritersRewrite(t *testing.T, narsil *engine.Narsil) map[string]string {
	t.Helper()
	stopped := &atomic.Bool{}
	writers := make([]busyWriter, busyCheckpointWriters)
	var group sync.WaitGroup
	for at := range writers {
		group.Go(func() { rewriteUntilStopped(narsil, at, stopped, &writers[at]) })
	}
	var checkpointErr error
	deadline := time.Now().Add(busyCheckpointLimit)
	for attempt := 0; attempt < busyCheckpointAttempts && time.Now().Before(deadline); attempt++ {
		if checkpointErr = narsil.Checkpoint(context.Background(), busyCheckpointIndex); checkpointErr != nil {
			break
		}
	}
	stopped.Store(true)
	group.Wait()
	if checkpointErr != nil {
		t.Fatalf("a checkpoint taken while writers rewrote documents failed with %s: %v", codeOrMessage(checkpointErr),
			checkpointErr)
	}
	latest := map[string]string{}
	for at, writer := range writers {
		if writer.failure != nil {
			t.Fatalf("writer %d failed with %s: %v", at, codeOrMessage(writer.failure), writer.failure)
		}
		for id, title := range writer.versions {
			latest[id] = title
		}
	}
	return latest
}

func TestCheckpointsTakenWhileWritersRewriteDocumentsSucceedAndKeepEveryWrite(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run(string(storage), func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			narsil := openBusyCheckpointEngine(t, directory)
			ctx := context.Background()
			if err := narsil.CreateIndex(ctx, busyCheckpointIndex, engine.IndexConfig{
				Schema: engine.Schema{"title": engine.FieldString}, Language: "english", TextStorage: storage}); err != nil {
				t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
			}
			latest := checkpointWhileWritersRewrite(t, narsil)
			if err := narsil.Shutdown(ctx); err != nil {
				t.Fatalf("the shutdown failed with %s: %v", codeOrMessage(err), err)
			}
			reopened := openBusyCheckpointEngine(t, directory)
			defer func() { _ = reopened.Shutdown(context.Background()) }()
			for id, title := range latest {
				stored, found, err := reopened.Get(ctx, busyCheckpointIndex, id)
				if err != nil || !found {
					t.Fatalf("after the restart %s is missing: found %v, error %v", id, found, err)
				}
				if held := stored.Map()["title"]; held != title {
					t.Fatalf("after the restart %s holds %q, while its last acknowledged write set %q", id, held, title)
				}
			}
		})
	}
}
