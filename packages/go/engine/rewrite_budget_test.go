package engine_test

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	rewriteBudgetIndex              = "letters"
	rewriteBudgetPartitions         = 8
	rewriteBudgetRounds             = 10
	rewriteBudgetDocumentsPerRound  = 320
	rewriteBudgetBodyLength         = 300
	rewriteBudgetBytes              = 4096
	rewriteBudgetMeasuredCheckpoint = 5
)

var rewriteBudgetSegmentFile = regexp.MustCompile(`/s(\d{16})[^/]*$`)

type rewriteBudgetFiles struct {
	ids   map[string]bool
	bytes int64
}

func rewriteBudgetPartitionFiles(t *testing.T, directory string) []rewriteBudgetFiles {
	t.Helper()
	files := make([]rewriteBudgetFiles, rewriteBudgetPartitions)
	for partitionID := range files {
		root := filepath.Join(directory, rewriteBudgetIndex, "segments", strconv.Itoa(partitionID))
		ids := map[string]bool{}
		for path := range filesUnder(t, root) {
			if match := rewriteBudgetSegmentFile.FindStringSubmatch(path); match != nil {
				ids[match[1]] = true
			}
		}
		files[partitionID] = rewriteBudgetFiles{ids: ids, bytes: partitionCheckpointFileBytes(t, directory,
			rewriteBudgetIndex, partitionID)}
	}
	return files
}

func rewriteBudgetID(round int, at int) string {
	return fmt.Sprintf("letter-%d-%d", round, at)
}

func TestASmallRewriteBudgetStillShrinksEveryPartitionAboveTheShareAtEveryCheckpoint(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run("text stored in "+string(storage), func(t *testing.T) {
			t.Parallel()
			ctx := context.Background()
			directory := t.TempDir()
			narsil := openSavedSizeEngine(t, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
				Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
					CheckpointMutationThreshold: engine.Some(savedSizeDistantThreshold),
					RewriteBytesPerCheckpoint:   engine.Some(int64(rewriteBudgetBytes))}})
			config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString, "body": engine.FieldString},
				TextStorage: storage, Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(rewriteBudgetPartitions)}}
			if err := narsil.CreateIndex(ctx, rewriteBudgetIndex, config); err != nil {
				t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
			}
			for round := range rewriteBudgetRounds {
				batch := make([]*engine.Document, 0, rewriteBudgetDocumentsPerRound)
				for at := range rewriteBudgetDocumentsPerRound {
					batch = append(batch, engine.DocumentFromMap(map[string]any{"id": rewriteBudgetID(round, at),
						"title": fmt.Sprintf("letter %d %d", round, at),
						"body":  bodyOf(round*rewriteBudgetDocumentsPerRound+at, rewriteBudgetBodyLength)}))
				}
				insertEvery(t, narsil, rewriteBudgetIndex, batch)
				checkpointOf(t, narsil, rewriteBudgetIndex)
			}
			removed := make([]string, 0, rewriteBudgetRounds*rewriteBudgetDocumentsPerRound/2)
			for round := range rewriteBudgetRounds {
				for at := 0; at < rewriteBudgetDocumentsPerRound; at += 2 {
					removed = append(removed, rewriteBudgetID(round, at))
				}
			}
			result, err := narsil.RemoveBatch(ctx, rewriteBudgetIndex, removed, engine.WriteOptions{})
			if err != nil || len(result.Failed) != 0 {
				t.Fatalf("the removals failed with %v and %d refused documents", err, len(result.Failed))
			}
			checkpointOf(t, narsil, rewriteBudgetIndex)

			for step := range rewriteBudgetMeasuredCheckpoint {
				before := rewriteBudgetPartitionFiles(t, directory)
				checkpointOf(t, narsil, rewriteBudgetIndex)
				after := rewriteBudgetPartitionFiles(t, directory)
				for partitionID := range rewriteBudgetPartitions {
					written := 0
					for id := range after[partitionID].ids {
						if !before[partitionID].ids[id] {
							written++
						}
					}
					if written != 1 {
						t.Fatalf("checkpoint %d wrote %d new segments for partition %d, while a budget of %d bytes "+
							"allows its one guaranteed rewrite", step, written, partitionID, rewriteBudgetBytes)
					}
					if after[partitionID].bytes >= before[partitionID].bytes {
						t.Fatalf("checkpoint %d left partition %d at %d bytes, from %d", step, partitionID,
							after[partitionID].bytes, before[partitionID].bytes)
					}
				}
			}

			live := rewriteBudgetRounds*rewriteBudgetDocumentsPerRound - len(removed)
			if count, err := narsil.CountDocuments(ctx, rewriteBudgetIndex); err != nil || count != live {
				t.Fatalf("the index counts %d documents with %v, while %d remain", count, err, live)
			}
			if _, found, err := narsil.Get(ctx, rewriteBudgetIndex, rewriteBudgetID(3, 1)); err != nil || !found {
				t.Fatalf("a kept document is missing, with %v", err)
			}
			if _, found, err := narsil.Get(ctx, rewriteBudgetIndex, rewriteBudgetID(3, 2)); err != nil || found {
				t.Fatalf("a removed document came back, with %v", err)
			}
		})
	}
}
