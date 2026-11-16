package engine_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	writeCostIndex                             = "letters"
	writeCostBodyLength                        = 300
	writeCostGrowthCheckpoints                 = 64
	writeCostDocumentsPerCheckpoint            = 40
	writeCostGrowthCompactionThreshold         = 2
	writeCostLargestWritesPerInsertedByte      = 10
	writeCostNoMergeCompactionThreshold        = 100
	writeCostLargeSegmentDocuments             = 1_000
	writeCostSmallSegmentDocuments             = 100
	writeCostSmallSegmentUpdates               = 90
	writeCostLargeSegmentUpdates               = 200
	writeCostFirstReplacementSeed              = writeCostLargeSegmentDocuments + writeCostSmallSegmentDocuments
	writeCostLargestRewriteShareOfLargeSegment = 0.6
)

type writeCostLetter struct {
	title string
	body  string
}

func writeCostSegmentFiles(t *testing.T, directory string) map[string]int64 {
	t.Helper()
	return filesUnder(t, filepath.Join(directory, writeCostIndex, "segments"))
}

func writeCostBytesWrittenBetween(before map[string]int64, after map[string]int64) int64 {
	var written int64
	for path, bytes := range after {
		if _, held := before[path]; !held {
			written += bytes
		}
	}
	return written
}

func writeCostLetterOf(seed int) writeCostLetter {
	return writeCostLetter{title: fmt.Sprintf("letter %d", seed), body: bodyOf(seed, writeCostBodyLength)}
}

func writeCostDocument(id string, letter writeCostLetter) *engine.Document {
	return engine.DocumentFromMap(map[string]any{"id": id, "title": letter.title, "body": letter.body})
}

func openWriteCostEngine(t *testing.T, directory string, storage engine.TextStorage, threshold int) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(savedSizeDistantThreshold),
			CompactionThreshold:         engine.Some(threshold)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	for _, index := range narsil.ListIndexes() {
		if index.Name == writeCostIndex {
			return narsil
		}
	}
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString, "body": engine.FieldString},
		TextStorage: storage, Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(1)}}
	if err := narsil.CreateIndex(ctx, writeCostIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func expectWriteCostLetters(t *testing.T, narsil *engine.Narsil, expected map[string]writeCostLetter, moment string) {
	t.Helper()
	ctx := context.Background()
	if count, err := narsil.CountDocuments(ctx, writeCostIndex); err != nil || count != len(expected) {
		t.Fatalf("%s, the index counts %d documents with %v, while it holds %d", moment, count, err, len(expected))
	}
	for id, letter := range expected {
		document, found, err := narsil.Get(ctx, writeCostIndex, id)
		if err != nil || !found {
			t.Fatalf("%s, document %s is missing, with %v", moment, id, err)
		}
		title, _ := document.Get("title")
		body, _ := document.Get("body")
		if title != letter.title || body != letter.body {
			t.Fatalf("%s, document %s reads %q and %q, while it holds %q and %q", moment, id, title, body,
				letter.title, letter.body)
		}
	}
}

func TestCheckpointsWriteEachInsertedByteAFewTimesWhileAnIndexGrowsPastItsCompactionThreshold(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run("text stored in "+string(storage), func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			narsil := openWriteCostEngine(t, directory, storage, writeCostGrowthCompactionThreshold)
			expected := map[string]writeCostLetter{}
			var written, firstWritten int64
			for checkpoint := range writeCostGrowthCheckpoints {
				batch := make([]*engine.Document, 0, writeCostDocumentsPerCheckpoint)
				for at := range writeCostDocumentsPerCheckpoint {
					id := fmt.Sprintf("letter-%d-%d", checkpoint, at)
					letter := writeCostLetterOf(checkpoint*writeCostDocumentsPerCheckpoint + at)
					expected[id] = letter
					batch = append(batch, writeCostDocument(id, letter))
				}
				insertEvery(t, narsil, writeCostIndex, batch)
				before := writeCostSegmentFiles(t, directory)
				checkpointOf(t, narsil, writeCostIndex)
				written += writeCostBytesWrittenBetween(before, writeCostSegmentFiles(t, directory))
				if checkpoint == 0 {
					firstWritten = written
				}
			}
			if firstWritten <= 0 {
				t.Fatalf("the first checkpoint wrote %d bytes of segment files", firstWritten)
			}
			limit := firstWritten * writeCostGrowthCheckpoints * writeCostLargestWritesPerInsertedByte
			if written > limit {
				t.Fatalf("%d checkpoints wrote %d bytes of segment files, %.1f times the bytes that they inserted, "+
					"above the limit of %d times", writeCostGrowthCheckpoints, written,
					float64(written)/float64(firstWritten*writeCostGrowthCheckpoints), writeCostLargestWritesPerInsertedByte)
			}
			expectWriteCostLetters(t, narsil, expected, "before the restart")
			shutDown(t, narsil, "before the restart")
			narsil = openWriteCostEngine(t, directory, storage, writeCostGrowthCompactionThreshold)
			expectWriteCostLetters(t, narsil, expected, "after the restart")
		})
	}
}

func TestACheckpointRewritesTheSegmentWithTheHighestShareOfReplacedDocumentsBeforeALargerOne(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run("text stored in "+string(storage), func(t *testing.T) {
			t.Parallel()
			ctx := context.Background()
			directory := t.TempDir()
			narsil := openWriteCostEngine(t, directory, storage, writeCostNoMergeCompactionThreshold)
			expected := map[string]writeCostLetter{}
			large := make([]*engine.Document, 0, writeCostLargeSegmentDocuments)
			for at := range writeCostLargeSegmentDocuments {
				id := fmt.Sprintf("large-%d", at)
				expected[id] = writeCostLetterOf(at)
				large = append(large, writeCostDocument(id, expected[id]))
			}
			insertEvery(t, narsil, writeCostIndex, large)
			checkpointOf(t, narsil, writeCostIndex)
			largeBytes := totalOf(writeCostSegmentFiles(t, directory))
			small := make([]*engine.Document, 0, writeCostSmallSegmentDocuments)
			for at := range writeCostSmallSegmentDocuments {
				id := fmt.Sprintf("small-%d", at)
				expected[id] = writeCostLetterOf(writeCostLargeSegmentDocuments + at)
				small = append(small, writeCostDocument(id, expected[id]))
			}
			insertEvery(t, narsil, writeCostIndex, small)
			checkpointOf(t, narsil, writeCostIndex)

			ids := make([]string, 0, writeCostSmallSegmentUpdates+writeCostLargeSegmentUpdates)
			for at := range writeCostSmallSegmentUpdates {
				ids = append(ids, fmt.Sprintf("small-%d", at))
			}
			for at := range writeCostLargeSegmentUpdates {
				ids = append(ids, fmt.Sprintf("large-%d", at))
			}
			updates := make([]engine.DocumentUpdate, 0, len(ids))
			for at, id := range ids {
				expected[id] = writeCostLetterOf(writeCostFirstReplacementSeed + at)
				updates = append(updates, engine.DocumentUpdate{DocID: id, Document: writeCostDocument(id, expected[id])})
			}
			result, err := narsil.UpdateBatch(ctx, writeCostIndex, updates, engine.WriteOptions{})
			requireBatchWritten(t, "the updates", result, err)
			before := writeCostSegmentFiles(t, directory)
			checkpointOf(t, narsil, writeCostIndex)
			written := writeCostBytesWrittenBetween(before, writeCostSegmentFiles(t, directory))
			limit := float64(largeBytes) * writeCostLargestRewriteShareOfLargeSegment
			if float64(written) >= limit {
				t.Fatalf("the checkpoint after the updates wrote %d bytes of segment files, at or above %.0f, so it "+
					"rewrote the %d-byte segment that holds the smaller share of replaced documents", written, limit,
					largeBytes)
			}
			expectWriteCostLetters(t, narsil, expected, "before the restart")
			shutDown(t, narsil, "before the restart")
			narsil = openWriteCostEngine(t, directory, storage, writeCostNoMergeCompactionThreshold)
			expectWriteCostLetters(t, narsil, expected, "after the restart")
		})
	}
}
