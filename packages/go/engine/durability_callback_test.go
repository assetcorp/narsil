package engine_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	durabilityCallbackChild   = "NARSIL_DURABILITY_CALLBACK_CHILD"
	durabilityCallbackTimeout = 10 * time.Second
)

func TestDurabilityFailureListenerCanReenter(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("The failing sync uses /dev/null")
	}
	if operation := os.Getenv(durabilityCallbackChild); operation != "" {
		testDurabilityFailureCallback(t, operation)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"checkpoint", "clear", "shutdown"} {
		t.Run(operation, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), durabilityCallbackTimeout)
			defer cancel()
			child := exec.CommandContext(ctx, executable, "-test.run=^TestDurabilityFailureListenerCanReenter$")
			child.Env = append(os.Environ(), durabilityCallbackChild+"="+operation)
			output, err := child.CombinedOutput()
			if err != nil {
				t.Fatalf("The %s listener failed or deadlocked: %v, context: %v\n%s", operation, err, ctx.Err(), output)
			}
		})
	}
}

func testDurabilityFailureCallback(t *testing.T, operation string) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openSharedFlushEngine(t, directory)
	if err := narsil.CreateIndex(ctx, sharedFlushIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		t.Fatal(err)
	}
	if _, err := narsil.Insert(ctx, sharedFlushIndex, engine.DocumentFromMap(map[string]any{"title": "seed"}),
		"seed", engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	shutDown(t, narsil, "before reopening")
	narsil = openSharedFlushEngine(t, directory)
	defer func() { _ = narsil.Shutdown(ctx) }()
	markers, err := filepath.Glob(filepath.Join(directory, sharedFlushIndex, "wal", "*", "commit"))
	if err != nil || len(markers) == 0 {
		t.Fatalf("The seeded index has no commit marker: %v", err)
	}
	for _, marker := range markers {
		if err := os.Remove(marker); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("/dev/null", marker); err != nil {
			t.Fatal(err)
		}
	}
	completed := make(chan error, 1)
	narsil.On(engine.EventHandlers{DurabilityError: func(event engine.DurabilityErrorEvent) {
		if engine.ErrorCode(event.Err) != engine.CodePersistenceFsyncFailed {
			completed <- event.Err
			return
		}
		var err error
		switch operation {
		case "checkpoint":
			err = narsil.Checkpoint(ctx, sharedFlushIndex)
		case "clear":
			err = narsil.Clear(ctx, sharedFlushIndex)
		case "shutdown":
			err = narsil.Shutdown(ctx)
		}
		completed <- err
	}})
	_, err = narsil.Insert(ctx, sharedFlushIndex, engine.DocumentFromMap(map[string]any{"title": "unflushed"}),
		"unflushed", engine.InsertOptions{})
	if engine.ErrorCode(err) != engine.CodePersistenceFsyncFailed {
		t.Fatalf("The failed sync returned %v", err)
	}
	if err := <-completed; engine.ErrorCode(err) != engine.CodePersistenceFsyncFailed &&
		engine.ErrorCode(err) != engine.CodePersistenceSaveFailed {
		t.Fatalf("The %s listener returned %v", operation, err)
	}
}
