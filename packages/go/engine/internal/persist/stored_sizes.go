package persist

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type StoredSize struct {
	SavedBytes model.Optional[int64]
	LogBytes   model.Optional[int64]
}

type savedSize struct {
	bytes      int64
	partitions map[uint32]int64
}

func savedSizeOf(listed manifest.Manifest) savedSize {
	saved := savedSize{partitions: make(map[uint32]int64, len(listed.Partitions))}
	for _, entry := range listed.Partitions {
		var bytes int64
		for _, segment := range entry.Segments {
			bytes += int64(segment.File.Bytes)
		}
		saved.partitions[entry.PartitionID] += bytes
		saved.bytes += bytes
	}
	for _, field := range listed.Vectors {
		for _, file := range field.Files {
			saved.bytes += int64(file.File.Bytes)
		}
		for _, part := range field.GraphParts {
			saved.bytes += int64(part.Bytes)
		}
	}
	return saved
}

type loggedFile struct {
	partitionID uint32
	bytes       int64
}

type indexLog struct {
	files       map[string]loggedFile
	bytes       int64
	byPartition map[uint32]int64
}

func newIndexLog() *indexLog {
	return &indexLog{files: map[string]loggedFile{}, byPartition: map[uint32]int64{}}
}

func (log *indexLog) add(partitionID uint32, delta int64) {
	log.bytes += delta
	log.byPartition[partitionID] += delta
}

func (log *indexLog) set(key string, partitionID uint32, bytes int64) {
	log.remove(key)
	log.files[key] = loggedFile{partitionID: partitionID, bytes: bytes}
	log.add(partitionID, bytes)
}

func (log *indexLog) remove(key string) {
	if previous, held := log.files[key]; held {
		delete(log.files, key)
		log.add(previous.partitionID, -previous.bytes)
	}
}

type storedSizes struct {
	mutex sync.Mutex
	saved map[string]savedSize
	logs  map[string]*indexLog
}

func newStoredSizes() *storedSizes {
	return &storedSizes{saved: map[string]savedSize{}, logs: map[string]*indexLog{}}
}

func partitionNumber(text string) (uint32, bool) {
	if text == "" {
		return 0, false
	}
	for _, character := range []byte(text) {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(text, 10, 32)
	return uint32(value), err == nil
}

func loggedFileOf(key string) (string, uint32, bool) {
	indexName, rest, found := strings.Cut(key, "/")
	if !found || indexName == "" {
		return "", 0, false
	}
	if logged, isLog := strings.CutPrefix(rest, "wal/"); isLog {
		partitionText, startText, found := strings.Cut(logged, "/")
		partitionID, numbered := partitionNumber(partitionText)
		if _, started := syncKeyDigits(startText); !found || !numbered || !started {
			return "", 0, false
		}
		return indexName, partitionID, true
	}
	segment, isHistory := parseHistoryKey(indexName, key)
	return indexName, segment.partition, isHistory
}

func (sizes *storedSizes) Tracks(key string) bool {
	_, _, logged := loggedFileOf(key)
	return logged
}

func (sizes *storedSizes) heldLog(key string) (*indexLog, uint32, bool) {
	indexName, partitionID, logged := loggedFileOf(key)
	if !logged {
		return nil, 0, false
	}
	log, held := sizes.logs[indexName]
	return log, partitionID, held
}

func (sizes *storedSizes) Sized(key string, bytes int64) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	if log, partitionID, held := sizes.heldLog(key); held {
		log.set(key, partitionID, bytes)
	}
}

func (sizes *storedSizes) Grew(key string, bytes int64) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	log, _, held := sizes.heldLog(key)
	if !held {
		return
	}
	if file, tracked := log.files[key]; tracked {
		file.bytes += bytes
		log.files[key] = file
		log.add(file.partitionID, bytes)
	}
}

func (sizes *storedSizes) Removed(key string) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	if log, _, held := sizes.heldLog(key); held {
		log.remove(key)
	}
}

func (sizes *storedSizes) recordSaved(indexName string, saved savedSize) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	sizes.saved[indexName] = saved
}

func (sizes *storedSizes) savedOf(indexName string) (savedSize, bool) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	saved, known := sizes.saved[indexName]
	return saved, known
}

func (sizes *storedSizes) startLog(indexName string) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	sizes.logs[indexName] = newIndexLog()
}

func (sizes *storedSizes) seedLog(directory *storage.Directory, indexName string) error {
	seeded := newIndexLog()
	for _, prefix := range []string{indexName + "/wal/", historyRoot(indexName)} {
		keys, err := directory.List(prefix)
		if err != nil {
			return err
		}
		for _, key := range keys {
			name, partitionID, logged := loggedFileOf(key)
			if !logged || name != indexName {
				continue
			}
			bytes, present, err := directory.Size(key)
			if err != nil {
				return err
			}
			if present {
				seeded.set(key, partitionID, bytes)
			}
		}
	}
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	sizes.logs[indexName] = seeded
	return nil
}

func (sizes *storedSizes) forget(indexName string) {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	delete(sizes.saved, indexName)
	delete(sizes.logs, indexName)
}

func (sizes *storedSizes) sizeOf(indexName string, logged bool, partitionID int) StoredSize {
	sizes.mutex.Lock()
	defer sizes.mutex.Unlock()
	saved := sizes.saved[indexName]
	size := StoredSize{SavedBytes: model.Some(saved.bytes)}
	if partitionID >= 0 {
		size.SavedBytes = model.Some(saved.partitions[uint32(partitionID)])
	}
	if !logged {
		return size
	}
	log := sizes.logs[indexName]
	switch {
	case log == nil:
		size.LogBytes = model.Some(int64(0))
	case partitionID >= 0:
		size.LogBytes = model.Some(log.byPartition[uint32(partitionID)])
	default:
		size.LogBytes = model.Some(log.bytes)
	}
	return size
}

func (manager *Manager) measureStored(indexName string, saved savedSize) error {
	manager.sizes.recordSaved(indexName, saved)
	if !manager.logged() {
		return nil
	}
	return manager.sizes.seedLog(manager.directory, indexName)
}

func (manager *Manager) measureStoredFromDisk(ctx context.Context, indexName string) {
	saved := savedSize{}
	read, err := checkpoint.ReadManifest(ctx, manager.store, indexName)
	if err == nil && read.Kind == checkpoint.ManifestCurrent {
		saved = savedSizeOf(read.Manifest)
	}
	_ = manager.measureStored(indexName, saved)
}

func (durable *Durable) StoredSize() StoredSize {
	return durable.manager.sizes.sizeOf(durable.handle.Name, durable.manager.logged(), -1)
}

func (durable *Durable) PartitionStoredSize(partitionID int) StoredSize {
	return durable.manager.sizes.sizeOf(durable.handle.Name, durable.manager.logged(), partitionID)
}

func stampSavedBytes(meta *metadata.Metadata, saved savedSize) {
	meta.SavedBytes = model.Some(uint64(max(saved.bytes, 0)))
}

func (durable *Durable) stampSavedBytes(meta *metadata.Metadata) {
	if saved, known := durable.manager.sizes.savedOf(durable.handle.Name); known {
		stampSavedBytes(meta, saved)
	}
}
