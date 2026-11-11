package suggestions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type ReadOutcome int

const (
	FileMissing ReadOutcome = iota
	FileRead
	FileTooLong
)

type Files interface {
	List(ctx context.Context, prefix string) ([]string, error)
	Read(ctx context.Context, key string) ([]byte, ReadOutcome, error)
	Write(ctx context.Context, key string, data []byte) error
	Remove(ctx context.Context, key string) error
}

type storeFiles struct{ store checkpoint.Store }

func StoreFiles(store checkpoint.Store) Files { return storeFiles{store: store} }

func (files storeFiles) List(ctx context.Context, prefix string) ([]string, error) {
	return files.store.List(ctx, prefix)
}

func (files storeFiles) Read(ctx context.Context, key string) ([]byte, ReadOutcome, error) {
	size, found, err := files.store.Size(ctx, key)
	if err != nil {
		return nil, FileMissing, err
	}
	if !found {
		return nil, FileMissing, nil
	}
	if size > MaxHistoryFileBytes {
		return nil, FileTooLong, nil
	}
	data, found, err := files.store.Read(ctx, key)
	if err != nil || !found {
		return nil, FileMissing, err
	}
	if len(data) > MaxHistoryFileBytes {
		return nil, FileTooLong, nil
	}
	return data, FileRead, nil
}

func (files storeFiles) Write(ctx context.Context, key string, data []byte) error {
	return files.store.Write(ctx, key, data)
}

func (files storeFiles) Remove(ctx context.Context, key string) error {
	return files.store.Remove(ctx, key)
}

type memoryFiles struct {
	mu    sync.RWMutex
	files map[string][]byte
}

func MemoryFiles() Files { return &memoryFiles{files: map[string][]byte{}} }

func (files *memoryFiles) List(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	files.mu.RLock()
	defer files.mu.RUnlock()
	keys := make([]string, 0)
	for key := range files.files {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}

func (files *memoryFiles) Read(ctx context.Context, key string) ([]byte, ReadOutcome, error) {
	if err := ctx.Err(); err != nil {
		return nil, FileMissing, err
	}
	files.mu.RLock()
	defer files.mu.RUnlock()
	data, found := files.files[key]
	if !found {
		return nil, FileMissing, nil
	}
	return data, FileRead, nil
}

func (files *memoryFiles) Write(ctx context.Context, key string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	files.mu.Lock()
	defer files.mu.Unlock()
	files.files[key] = append([]byte(nil), data...)
	return nil
}

func (files *memoryFiles) Remove(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	files.mu.Lock()
	defer files.mu.Unlock()
	delete(files.files, key)
	return nil
}

var (
	dayFilePattern      = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.nrsl$`)
	restoredFilePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})-(\d{4})\.nrsl$`)
)

func FolderOf(indexName string) string { return HistoryFolder + "/" + indexName + "/" }

func DayFileKey(indexName, day string) string { return FolderOf(indexName) + day + ".nrsl" }

func RestoredFileKey(indexName, day string, sequence int) string {
	padded := strconv.Itoa(sequence)
	for len(padded) < 4 {
		padded = "0" + padded
	}
	return FolderOf(indexName) + RestoredFolder + "/" + day + "-" + padded + ".nrsl"
}

func BuildRecordKey(indexName string) string { return FolderOf(indexName) + BuildRecordFile }

type HistoryFile struct {
	Key      string
	Day      string
	Restored bool
}

func HistoryFileOf(indexName, key string) (HistoryFile, bool) {
	folder := FolderOf(indexName)
	if !strings.HasPrefix(key, folder) {
		return HistoryFile{}, false
	}
	rest := key[len(folder):]
	if match := dayFilePattern.FindStringSubmatch(rest); match != nil {
		return HistoryFile{Key: key, Day: match[1]}, true
	}
	restoredPrefix := RestoredFolder + "/"
	if !strings.HasPrefix(rest, restoredPrefix) {
		return HistoryFile{}, false
	}
	if match := restoredFilePattern.FindStringSubmatch(rest[len(restoredPrefix):]); match != nil {
		return HistoryFile{Key: key, Day: match[1], Restored: true}, true
	}
	return HistoryFile{}, false
}

func ListHistoryFolder(ctx context.Context, files Files, indexName string) ([]string, error) {
	return files.List(ctx, FolderOf(indexName))
}

func RemoveHistoryFolder(ctx context.Context, files Files, indexName string) error {
	keys, err := ListHistoryFolder(ctx, files, indexName)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := files.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func RestoreStagingPrefix() string {
	random := make([]byte, 16)
	_, _ = rand.Read(random)
	return HistoryFolder + "/" + RestoreStagingInfix + hex.EncodeToString(random) + "/"
}

func RemoveRestoreLeftovers(ctx context.Context, files Files) error {
	keys, err := files.List(ctx, HistoryFolder+"/"+RestoreStagingInfix)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := files.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}
