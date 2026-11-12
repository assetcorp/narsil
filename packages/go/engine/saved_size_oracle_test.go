package engine_test

import (
	"context"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	savedSizeRewriteShare  = 0.2
	savedSizeAllowedGrowth = 1.1
)

var (
	savedSizeLogFile     = regexp.MustCompile(`/wal/\d+/\d{16}$`)
	savedSizeHistoryFile = regexp.MustCompile(`/history/\d+/\d{16}-\d{16}$`)
	savedSizeWords       = []string{"river", "stone", "cloud", "ember", "forest", "harbour", "lantern", "meadow",
		"orbit", "quarry"}
)

func filesUnder(t *testing.T, root string) map[string]int64 {
	t.Helper()
	sizes := map[string]int64{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		sizes[filepath.ToSlash(path)] = info.Size()
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s failed: %v", root, err)
	}
	return sizes
}

func totalOf(sizes map[string]int64) int64 {
	var total int64
	for _, size := range sizes {
		total += size
	}
	return total
}

func checkpointFileBytes(t *testing.T, directory string, indexName string) int64 {
	t.Helper()
	return totalOf(filesUnder(t, filepath.Join(directory, indexName, "segments")))
}

func partitionCheckpointFileBytes(t *testing.T, directory string, indexName string, partitionID int) int64 {
	t.Helper()
	return totalOf(filesUnder(t, filepath.Join(directory, indexName, "segments", strconv.Itoa(partitionID))))
}

func logFileBytes(t *testing.T, directory string, indexName string) int64 {
	t.Helper()
	var total int64
	for path, size := range filesUnder(t, filepath.Join(directory, indexName)) {
		if savedSizeLogFile.MatchString(path) || savedSizeHistoryFile.MatchString(path) {
			total += size
		}
	}
	return total
}

func bodyOf(seed int, length int) string {
	parts := []string{"shared"}
	state := uint64(seed + 1)
	size := 0
	for size < length {
		state = (state*1103515245 + 12345) % 2147483648
		word := savedSizeWords[state%uint64(len(savedSizeWords))] + strconv.FormatUint(state%997, 10)
		parts = append(parts, word)
		size += len(word) + 1
	}
	return strings.Join(parts, " ")
}

func savedBytesAllowedFor(liveDocuments int, bytesPerDocument float64) int64 {
	return int64(math.Ceil(float64(liveDocuments) / (1 - savedSizeRewriteShare) * bytesPerDocument *
		savedSizeAllowedGrowth))
}

func figure(t *testing.T, label string, value engine.Optional[int64]) int64 {
	t.Helper()
	held, set := value.Get()
	if !set {
		t.Fatalf("%s is absent", label)
	}
	return held
}

func requireFiguresMatchTheFiles(t *testing.T, narsil *engine.Narsil, directory string, indexName string) {
	t.Helper()
	stats, err := narsil.GetStats(indexName)
	if err != nil {
		t.Fatalf("reading the stats failed with %s: %v", codeOrMessage(err), err)
	}
	if saved, onDisk := figure(t, "the saved size", stats.SavedBytes), checkpointFileBytes(t, directory,
		indexName); saved != onDisk {
		t.Fatalf("the index reports a saved size of %d bytes, while its checkpoint files hold %d", saved, onDisk)
	}
	logged := figure(t, "the log size", stats.LogBytes)
	if onDisk := logFileBytes(t, directory, indexName); logged != onDisk {
		t.Fatalf("the index reports a log size of %d bytes, while its log files hold %d", logged, onDisk)
	}
	partitions, err := narsil.GetPartitionStats(indexName)
	if err != nil {
		t.Fatalf("reading the partition stats failed with %s: %v", codeOrMessage(err), err)
	}
	var partitionLogs, partitionSaved int64
	for _, partition := range partitions {
		saved := figure(t, "the saved size of a partition", partition.SavedBytes)
		onDisk := partitionCheckpointFileBytes(t, directory, indexName, partition.PartitionID)
		if saved != onDisk {
			t.Fatalf("partition %d reports a saved size of %d bytes, while its segment files hold %d",
				partition.PartitionID, saved, onDisk)
		}
		partitionSaved += saved
		partitionLogs += figure(t, "the log size of a partition", partition.LogBytes)
	}
	if partitionLogs != logged {
		t.Fatalf("the partitions report %d log bytes between them, while the index reports %d", partitionLogs, logged)
	}
	if partitionSaved > figure(t, "the saved size", stats.SavedBytes) {
		t.Fatalf("the partitions report %d saved bytes between them, more than the index reports", partitionSaved)
	}
}

func requireDocumentsOf(t *testing.T, narsil *engine.Narsil, indexName string, expected map[string]string,
	removed []string) {
	t.Helper()
	ctx := context.Background()
	count, err := narsil.CountDocuments(ctx, indexName)
	if err != nil || count != len(expected) {
		t.Fatalf("the index counts %d documents with error %v, while the acknowledged writes leave %d", count, err,
			len(expected))
	}
	for id, body := range expected {
		stored, found, err := narsil.Get(ctx, indexName, id)
		if err != nil || !found {
			t.Fatalf("%s is missing: found %v, error %v", id, found, err)
		}
		if held := stored.Map()["body"]; held != body {
			t.Fatalf("%s holds a body other than the one that its last acknowledged write stored", id)
		}
	}
	for _, id := range removed {
		if _, kept := expected[id]; kept {
			continue
		}
		if _, found, err := narsil.Get(ctx, indexName, id); err != nil || found {
			t.Fatalf("%s came back after its acknowledged removal: found %v, error %v", id, found, err)
		}
	}
}
