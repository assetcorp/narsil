package engine_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	releaseCycles               = 40
	mappingsAllowedAcrossCycles = 64
	processMappingsPath         = "/proc/self/maps"
	processHandlesPath          = "/proc/self/fd"
)

func processMappingCount() (int, bool) {
	runtime.GC()
	runtime.GC()
	listed, err := os.ReadFile(processMappingsPath)
	if err != nil {
		return 0, false
	}
	return strings.Count(string(listed), "\n"), true
}

func handlesUnder(directory string) []string {
	var held []string
	entries, err := os.ReadDir(processHandlesPath)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		target, err := os.Readlink(filepath.Join(processHandlesPath, entry.Name()))
		if err == nil && strings.HasPrefix(target, directory) {
			held = append(held, target)
		}
	}
	listed, _ := os.ReadFile(processMappingsPath)
	for _, line := range strings.Split(string(listed), "\n") {
		if at := strings.Index(line, directory); at >= 0 {
			held = append(held, line[at:])
		}
	}
	return held
}

func startCreateAndShutDown(t *testing.T, ctx context.Context) {
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("starting the engine failed: %v", err)
	}
	for _, name := range []string{"kept", "dropped"} {
		if err := narsil.CreateIndex(ctx, name, parityBaseIndex()); err != nil {
			t.Fatalf("creating %s failed: %v", name, err)
		}
		result, err := narsil.InsertBatch(ctx, name, documentsFromMaps(parityBaseDocumentList()), engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			t.Fatalf("inserting into %s failed: %v %+v", name, err, result.Failed)
		}
	}
	if err := narsil.DropIndex(ctx, "dropped"); err != nil {
		t.Fatalf("dropping an index failed: %v", err)
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("shutting down failed: %v", err)
	}
}

func TestDroppedAndShutDownIndexesGiveBackTheirMemoryMappings(t *testing.T) {
	ctx := context.Background()
	startCreateAndShutDown(t, ctx)
	before, readable := processMappingCount()
	if !readable {
		t.Skip("this platform lists no process memory mappings")
	}
	for range releaseCycles {
		startCreateAndShutDown(t, ctx)
	}
	after, _ := processMappingCount()
	if grown := after - before; grown > mappingsAllowedAcrossCycles {
		t.Fatalf("%d engines that each dropped one index and shut down left %d more memory mappings in the process, more than %d",
			releaseCycles, grown, mappingsAllowedAcrossCycles)
	}
}

func TestShutdownClosesEveryFileOfAnIndexThatKeepsItsTextOnDisk(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	copyTree(t, samplesPath("checkpoints", "notes"), filepath.Join(root, "notes"))
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: root}})
	if err != nil {
		t.Fatalf("opening the sample failed: %v", err)
	}
	if _, err := narsil.Query(ctx, "notes", engine.QueryParams{Term: "kettle"}); err != nil {
		t.Fatalf("searching the sample failed: %v", err)
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("shutting down failed: %v", err)
	}
	if held := handlesUnder(root); len(held) > 0 {
		t.Fatalf("the process still holds these files of the index after Shutdown: %v", held)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatalf("removing the index directory after Shutdown failed: %v", err)
	}
}
