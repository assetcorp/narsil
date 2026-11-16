package engine_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	buildFilesIndex        = "ledger"
	buildFilesBatch        = 200
	buildFilesWordsPerBody = 40
	buildFilesPollInterval = 200 * time.Microsecond
	buildFilesSearchTime   = time.Minute
)

var listedSegmentKey = regexp.MustCompile(`segments/(\d+)/s(\d{16})`)

func highestListedSegments(listed []byte) map[string]uint64 {
	highest := map[string]uint64{}
	for _, match := range listedSegmentKey.FindAllSubmatch(listed, -1) {
		id, _ := strconv.ParseUint(string(match[2]), 10, 64)
		partition := string(match[1])
		if current, seen := highest[partition]; !seen || id > current {
			highest[partition] = id
		}
	}
	return highest
}

func uncommittedBuildFiles(directory string, indexName string) ([]string, error) {
	listed, err := manifestPayloadAt(filepath.Join(directory, indexName, "manifest"))
	if err != nil {
		return nil, err
	}
	highest := highestListedSegments(listed)
	stray, err := strayFiles(directory, indexName)
	if err != nil {
		return nil, err
	}
	var built []string
	for _, key := range stray {
		if strings.Contains(key, temporaryFileMarker) {
			built = append(built, key)
			continue
		}
		match := listedSegmentKey.FindStringSubmatch(key)
		if match == nil {
			continue
		}
		id, _ := strconv.ParseUint(match[2], 10, 64)
		if current, seen := highest[match[1]]; !seen || id > current {
			built = append(built, key)
		}
	}
	return built, nil
}

func buildFilesEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointMutationThreshold: engine.Some(buildFilesBatch)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func buildFilesBatchAt(round int) []*engine.Document {
	batch := make([]*engine.Document, buildFilesBatch)
	for at := range batch {
		words := make([]string, buildFilesWordsPerBody)
		for word := range words {
			words[word] = fmt.Sprintf("w%dx%dx%d", round, at, word)
		}
		batch[at] = engine.DocumentFromMap(map[string]any{"id": fmt.Sprintf("r%05d-%03d", round, at),
			"body": strings.Join(words, " ")})
	}
	return batch
}

func writeUntilABuildHasFilesOnDisk(t *testing.T, narsil *engine.Narsil, directory string) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, buildFilesIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Partitions: engine.PartitionConfig{MaxDocsPerPartition: engine.Some(crashDocsPerPartition), MaxPartitions: engine.Some(3)}}); err != nil {
		t.Fatal(err)
	}
	stop, written := make(chan struct{}), make(chan error, 1)
	go func() {
		for round := 0; ; round++ {
			select {
			case <-stop:
				written <- nil
				return
			default:
			}
			if _, err := narsil.InsertBatch(ctx, buildFilesIndex, buildFilesBatchAt(round), engine.InsertOptions{}); err != nil {
				written <- err
				return
			}
		}
	}()
	defer func() {
		close(stop)
		if err := <-written; err != nil {
			t.Fatalf("a write beside the background checkpoints failed with %s: %v", codeOrMessage(err), err)
		}
	}()
	deadline := time.Now().Add(buildFilesSearchTime)
	for time.Now().Before(deadline) {
		if built, err := uncommittedBuildFiles(directory, buildFilesIndex); err == nil && len(built) > 0 {
			return
		}
		time.Sleep(buildFilesPollInterval)
	}
	t.Fatalf("no background checkpoint left a file on disk that its manifest had yet to list within %s", buildFilesSearchTime)
}

func TestClosingOrDroppingAnIndexDuringABackgroundCheckpointLeavesNoFileOfThatBuild(t *testing.T) {
	t.Parallel()
	for name, finish := range map[string]func(*engine.Narsil) error{
		"close": func(narsil *engine.Narsil) error { return narsil.Close(context.Background(), buildFilesIndex) },
		"drop":  func(narsil *engine.Narsil) error { return narsil.DropIndex(context.Background(), buildFilesIndex) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			narsil := buildFilesEngine(t, directory)
			writeUntilABuildHasFilesOnDisk(t, narsil, directory)
			if err := finish(narsil); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			built, err := uncommittedBuildFiles(directory, buildFilesIndex)
			if err != nil {
				t.Fatalf("listing the directory after the %s failed: %v", name, err)
			}
			if len(built) > 0 {
				t.Fatalf("after the %s returned, %d files of a checkpoint that never committed are left, such as %v", name,
					len(built), built[:min(len(built), 5)])
			}
			if name == "drop" {
				if _, err := os.Stat(filepath.Join(directory, buildFilesIndex, "manifest")); !os.IsNotExist(err) {
					t.Fatalf("after the drop, the manifest of the dropped index is still on disk: %v", err)
				}
			}
			shutDownWithin(t, narsil, "after the "+name)
			reopened := buildFilesEngine(t, directory)
			requireNoStrayFiles(t, directory, buildFilesIndex, "once the engine opened the directory again")
			shutDownWithin(t, reopened, "after the reopen")
		})
	}
}
