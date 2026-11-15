package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	pinCrashDirectoryVariable = "NARSIL_PIN_CRASH_DIRECTORY"
	pinCrashReadyVariable     = "NARSIL_PIN_CRASH_READY"
	pinCrashChildTimeout      = 2 * time.Minute
	pinCrashReadyPoll         = 2 * time.Millisecond
)

type stalledWriter struct {
	readyPath string
	listing   []string
}

func (w *stalledWriter) Write([]byte) (int, error) {
	staged := w.readyPath + ".staged"
	if err := os.WriteFile(staged, []byte(strings.Join(w.listing, "\n")), 0o644); err != nil {
		return 0, err
	}
	if err := os.Rename(staged, w.readyPath); err != nil {
		return 0, err
	}
	select {}
}

func topLevelNames(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	slices.Sort(names)
	return names, nil
}

func runPinCrashChild(directory string, readyPath string) error {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		return err
	}
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		return err
	}
	documents := make([]*engine.Document, archivedDocuments)
	for at := range documents {
		documents[at] = engine.NewDocument().Set("id", archivedID(at)).Set("title", fmt.Sprintf("harbour %d", at))
	}
	if result, err := narsil.InsertBatch(ctx, callbackIndex, documents, engine.InsertOptions{}); err != nil {
		return err
	} else if len(result.Failed) != 0 {
		return result.Failed[0].Err
	}
	if err := narsil.Checkpoint(ctx, callbackIndex); err != nil {
		return err
	}
	listing, err := topLevelNames(directory)
	if err != nil {
		return err
	}
	return narsil.Snapshot(ctx, callbackIndex, engine.SnapshotOptions{}, &stalledWriter{readyPath: readyPath, listing: listing})
}

func listingWhenTheChildStalled(t *testing.T, directory string) []string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	readyPath := filepath.Join(t.TempDir(), "ready")
	child := exec.Command(executable, "-test.run=^$")
	child.Env = append(os.Environ(), pinCrashDirectoryVariable+"="+directory, pinCrashReadyVariable+"="+readyPath)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatalf("starting the child failed: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	deadline := time.Now().Add(pinCrashChildTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			t.Fatalf("the child stopped before its snapshot streamed: %v\n%s", err, stderr.String())
		default:
		}
		if data, err := os.ReadFile(readyPath); err == nil {
			if err := child.Process.Kill(); err != nil {
				t.Fatalf("killing the child failed: %v", err)
			}
			<-exited
			if strings.Contains(stderr.String(), "DATA RACE") {
				t.Fatalf("the race detector reported a race in the child:\n%s", stderr.String())
			}
			return strings.Split(string(data), "\n")
		}
		time.Sleep(pinCrashReadyPoll)
	}
	_ = child.Process.Kill()
	<-exited
	t.Fatalf("the child did not start streaming its snapshot within %s\n%s", pinCrashChildTimeout, stderr.String())
	return nil
}

func TestAReopenRemovesTheFilesThatACrashedSnapshotKept(t *testing.T) {
	directory := t.TempDir()
	before := listingWhenTheChildStalled(t, directory)
	if crashed := topLevelEntries(t, directory); slices.Equal(crashed, before) {
		t.Fatalf("the snapshot that the crash stopped left the directory as it was before, %v, so nothing tests the reopen", before)
	}
	reopened := engineIn(t, directory)
	defer shutDownWithin(t, reopened, "after the reopen")
	if after := topLevelEntries(t, directory); !slices.Equal(after, before) {
		t.Fatalf("after the reopen, the directory holds %v; before the crashed snapshot it held %v", after, before)
	}
	reference := make(map[string]string, archivedDocuments)
	for at := range archivedDocuments {
		reference[archivedID(at)] = fmt.Sprintf("harbour %d", at)
	}
	requireTitles(t, reopened, callbackIndex, reference, nil)
}
