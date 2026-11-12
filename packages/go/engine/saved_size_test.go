package engine_test

import (
	"bytes"
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	savedSizeIndex            = "shelves"
	savedSizeDocuments        = 2400
	savedSizeBatch            = 400
	savedSizeBodyLength       = 1200
	savedSizeRemoved          = 1000
	savedSizeUpdated          = 300
	savedSizeMaxPartitions    = 3
	savedSizeDocsPerPartition = 1000
	savedSizeDistantThreshold = 1_000_000_000
	savedSizeShortInterval    = 100 * time.Millisecond
	savedSizePoll             = 20 * time.Millisecond
	savedSizeDeadline         = time.Minute
	savedSizeQuietCheckpoints = 3
)

func savedSizeConfig(directory string, interval time.Duration) engine.Config {
	durability := &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
		CheckpointMutationThreshold: engine.Some(savedSizeDistantThreshold)}
	if interval > 0 {
		durability.CheckpointInterval = engine.Some(interval)
	}
	return engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}, Durability: durability}
}

func openSavedSizeEngine(t *testing.T, config engine.Config) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func checkpointOf(t *testing.T, narsil *engine.Narsil, indexName string) {
	t.Helper()
	if err := narsil.Checkpoint(context.Background(), indexName); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
}

func savedBytesOf(t *testing.T, narsil *engine.Narsil, indexName string) int64 {
	t.Helper()
	stats, err := narsil.GetStats(indexName)
	if err != nil {
		t.Fatalf("reading the stats failed with %s: %v", codeOrMessage(err), err)
	}
	return figure(t, "the saved size", stats.SavedBytes)
}

func vectorOf(seed int) []any {
	value := float64(seed)
	return []any{float64(int(value)%7) / 7, float64(int(value)%5) / 5, float64(int(value)%3) / 3, 1.0}
}

func shelfDocument(id string, number int, body string) *engine.Document {
	return engine.DocumentFromMap(map[string]any{"id": id, "title": "shelf " + strconv.Itoa(number), "body": body,
		"embedding": vectorOf(number)})
}

func createShelves(t *testing.T, narsil *engine.Narsil, storage engine.TextStorage) map[string]string {
	t.Helper()
	ctx := context.Background()
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString, "body": engine.FieldString,
		"embedding": engine.VectorFieldType(4)}, TextStorage: storage,
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(savedSizeMaxPartitions),
			MaxDocsPerPartition: engine.Some(savedSizeDocsPerPartition)}}
	if err := narsil.CreateIndex(ctx, savedSizeIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	expected := map[string]string{}
	for first := 0; first < savedSizeDocuments; first += savedSizeBatch {
		batch := make([]*engine.Document, 0, savedSizeBatch)
		for number := first; number < first+savedSizeBatch; number++ {
			id := "shelf-" + strconv.Itoa(number)
			expected[id] = bodyOf(number, savedSizeBodyLength)
			batch = append(batch, shelfDocument(id, number, expected[id]))
		}
		insertEvery(t, narsil, savedSizeIndex, batch)
	}
	return expected
}

func removeAndReplace(t *testing.T, narsil *engine.Narsil, expected map[string]string) []string {
	t.Helper()
	ctx := context.Background()
	updates := make([]engine.DocumentUpdate, 0, savedSizeUpdated)
	for number := 1; number < savedSizeUpdated*2; number += 2 {
		id := "shelf-" + strconv.Itoa(number)
		expected[id] = bodyOf(number+savedSizeDocuments, savedSizeBodyLength)
		updates = append(updates, engine.DocumentUpdate{DocID: id, Document: shelfDocument(id, number, expected[id])})
	}
	result, err := narsil.UpdateBatch(ctx, savedSizeIndex, updates, engine.WriteOptions{})
	if err != nil || len(result.Failed) != 0 {
		t.Fatalf("the updates failed with %v and %d refused documents", err, len(result.Failed))
	}
	removed := make([]string, 0, savedSizeRemoved)
	for number := 0; number < savedSizeRemoved*2; number += 2 {
		removed = append(removed, "shelf-"+strconv.Itoa(number))
	}
	result, err = narsil.RemoveBatch(ctx, savedSizeIndex, removed, engine.WriteOptions{})
	if err != nil || len(result.Failed) != 0 {
		t.Fatalf("the removals failed with %v and %d refused documents", err, len(result.Failed))
	}
	for _, id := range removed {
		delete(expected, id)
	}
	return removed
}

func waitForSavedBytesAtMost(t *testing.T, narsil *engine.Narsil, allowed int64) int64 {
	t.Helper()
	deadline := time.Now().Add(savedSizeDeadline)
	for {
		saved := savedBytesOf(t, narsil, savedSizeIndex)
		if saved <= allowed {
			return saved
		}
		if time.Now().After(deadline) {
			t.Fatalf("the saved size stayed at %d bytes for %v of scheduled checkpoints, above the %d bytes that "+
				"a removed share of at most 0.2 allows", saved, savedSizeDeadline, allowed)
		}
		time.Sleep(savedSizePoll)
	}
}

func TestSavedSizeMatchesTheFilesAndFallsOnceRemovalsPassTheShare(t *testing.T) {
	for _, storage := range []engine.TextStorage{engine.TextStorageMemory, engine.TextStorageDisk} {
		t.Run("text stored in "+string(storage), func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			narsil := openSavedSizeEngine(t, savedSizeConfig(directory, 0))
			expected := createShelves(t, narsil, storage)
			checkpointOf(t, narsil, savedSizeIndex)
			requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
			savedAfterInsert := savedBytesOf(t, narsil, savedSizeIndex)
			bytesPerDocument := float64(savedAfterInsert) / savedSizeDocuments
			shutDown(t, narsil, "after the inserts")

			narsil = openSavedSizeEngine(t, savedSizeConfig(directory, savedSizeShortInterval))
			removed := removeAndReplace(t, narsil, expected)
			allowed := min(savedBytesAllowedFor(len(expected), bytesPerDocument), savedAfterInsert-1)
			waitForSavedBytesAtMost(t, narsil, allowed)
			requireDocumentsOf(t, narsil, savedSizeIndex, expected, removed)
			shutDown(t, narsil, "after the scheduled checkpoints")

			narsil = openSavedSizeEngine(t, savedSizeConfig(directory, 0))
			requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
			requireDocumentsOf(t, narsil, savedSizeIndex, expected, removed)
			checkpointOf(t, narsil, savedSizeIndex)
			settled := savedBytesOf(t, narsil, savedSizeIndex)
			if settled > allowed {
				t.Fatalf("the saved size grew back to %d bytes after a restart, above %d", settled, allowed)
			}
			for range savedSizeQuietCheckpoints {
				checkpointOf(t, narsil, savedSizeIndex)
			}
			if again := savedBytesOf(t, narsil, savedSizeIndex); again != settled {
				t.Fatalf("checkpoints with no write moved the saved size from %d to %d bytes", settled, again)
			}
			requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
			shutDown(t, narsil, "after the checkpoints with no write")

			narsil = openSavedSizeEngine(t, savedSizeConfig(directory, 0))
			if reopened := savedBytesOf(t, narsil, savedSizeIndex); reopened != settled {
				t.Fatalf("the saved size reads %d bytes after a restart, while it read %d before", reopened, settled)
			}
			requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
			requireDocumentsOf(t, narsil, savedSizeIndex, expected, removed)
		})
	}
}

func TestSavedSizeFollowsARestoreAndKeepsItsFigureThroughOneThatFails(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	config := savedSizeConfig(directory, 0)
	narsil := openSavedSizeEngine(t, config)
	expected := createShelves(t, narsil, engine.TextStorageMemory)
	var archive bytes.Buffer
	if err := narsil.Snapshot(ctx, savedSizeIndex, engine.SnapshotOptions{}, &archive); err != nil {
		t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	removed := removeAndReplace(t, narsil, map[string]string{})
	checkpointOf(t, narsil, savedSizeIndex)
	before := savedBytesOf(t, narsil, savedSizeIndex)

	if err := narsil.Restore(ctx, savedSizeIndex, bytes.NewReader([]byte{1, 2, 3, 4})); err == nil {
		t.Fatal("the engine restored an archive of four arbitrary bytes")
	}
	if after := savedBytesOf(t, narsil, savedSizeIndex); after != before {
		t.Fatalf("a failed restore moved the saved size from %d to %d bytes", before, after)
	}
	requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)

	if err := narsil.Restore(ctx, savedSizeIndex, &archive); err != nil {
		t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
	}
	requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
	requireDocumentsOf(t, narsil, savedSizeIndex, expected, removed)
	restored := savedBytesOf(t, narsil, savedSizeIndex)

	insertEvery(t, narsil, savedSizeIndex, []*engine.Document{shelfDocument("after-restore", savedSizeDocuments,
		bodyOf(savedSizeDocuments+1, savedSizeBodyLength))})
	requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
	shutDown(t, narsil, "after the restore")

	narsil = openSavedSizeEngine(t, config)
	if reopened := savedBytesOf(t, narsil, savedSizeIndex); reopened != restored {
		t.Fatalf("the saved size reads %d bytes after a restart, while the restore left %d", reopened, restored)
	}
	requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
}

func TestClosedIndexReportsItsSavedSizeFromItsMetadataAndNoLogSize(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	config := savedSizeConfig(directory, 0)
	config.Lifecycle = &engine.IndexLifecycleConfig{}
	narsil := openSavedSizeEngine(t, config)
	createShelves(t, narsil, engine.TextStorageMemory)
	if err := narsil.Close(ctx, savedSizeIndex); err != nil {
		t.Fatalf("closing the index failed with %s: %v", codeOrMessage(err), err)
	}
	requireClosedFigures(t, narsil, directory)
	shutDown(t, narsil, "after closing the index")

	narsil = openSavedSizeEngine(t, config)
	requireClosedFigures(t, narsil, directory)
	if err := narsil.Open(ctx, savedSizeIndex); err != nil {
		t.Fatalf("opening the index failed with %s: %v", codeOrMessage(err), err)
	}
	requireFiguresMatchTheFiles(t, narsil, directory, savedSizeIndex)
}

func requireClosedFigures(t *testing.T, narsil *engine.Narsil, directory string) {
	t.Helper()
	stats, err := narsil.GetStats(savedSizeIndex)
	if err != nil {
		t.Fatalf("reading the stats of the closed index failed with %s: %v", codeOrMessage(err), err)
	}
	if saved, onDisk := figure(t, "the saved size of a closed index", stats.SavedBytes),
		checkpointFileBytes(t, directory, savedSizeIndex); saved != onDisk {
		t.Fatalf("the closed index reports a saved size of %d bytes, while its checkpoint files hold %d", saved, onDisk)
	}
	if logged, set := stats.LogBytes.Get(); set {
		t.Fatalf("the closed index reports a log size of %d bytes", logged)
	}
}

func TestIndexWithoutPersistenceReportsNeitherFigure(t *testing.T) {
	t.Parallel()
	narsil := openPlainEngine(t, engine.Config{})
	if err := narsil.CreateIndex(context.Background(), savedSizeIndex,
		engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	insertEvery(t, narsil, savedSizeIndex, []*engine.Document{engine.DocumentFromMap(map[string]any{"id": "one",
		"title": "only in memory"})})
	stats, err := narsil.GetStats(savedSizeIndex)
	if err != nil {
		t.Fatalf("reading the stats failed with %s: %v", codeOrMessage(err), err)
	}
	if stats.SavedBytes.IsSet() || stats.LogBytes.IsSet() {
		t.Fatalf("an index without persistence reports a saved size %v and a log size %v", stats.SavedBytes,
			stats.LogBytes)
	}
	partitions, err := narsil.GetPartitionStats(savedSizeIndex)
	if err != nil {
		t.Fatalf("reading the partition stats failed with %s: %v", codeOrMessage(err), err)
	}
	for _, partition := range partitions {
		if partition.SavedBytes.IsSet() || partition.LogBytes.IsSet() {
			t.Fatalf("partition %d of an index without persistence reports a saved or log size", partition.PartitionID)
		}
	}
}
