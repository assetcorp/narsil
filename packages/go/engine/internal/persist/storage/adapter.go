package storage

import (
	"context"
	"slices"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Adapter interface {
	Save(ctx context.Context, key string, data []byte) error
	Load(ctx context.Context, key string) ([]byte, bool, error)
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) ([]string, error)
}

type Memory struct {
	mutex sync.RWMutex
	files map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{files: map[string][]byte{}}
}

func validMemoryKey(key string) error {
	if strings.ContainsRune(key, 0) {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed, "Invalid key: null byte detected", nil)
	}
	return nil
}

func (memory *Memory) Save(ctx context.Context, key string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return saveFailed(`Saving "`+key+`" was cancelled`, key, err)
	}
	if err := validMemoryKey(key); err != nil {
		return err
	}
	memory.mutex.Lock()
	memory.files[key] = slices.Clone(data)
	memory.mutex.Unlock()
	return nil
}

func (memory *Memory) Load(ctx context.Context, key string) ([]byte, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, loadFailed(`Loading "`+key+`" was cancelled`, key, err)
	}
	memory.mutex.RLock()
	data, found := memory.files[key]
	memory.mutex.RUnlock()
	if !found {
		return nil, false, nil
	}
	return slices.Clone(data), true, nil
}

func (memory *Memory) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return deleteFailed(key, err)
	}
	memory.mutex.Lock()
	delete(memory.files, key)
	memory.mutex.Unlock()
	return nil
}

func (memory *Memory) List(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, loadFailed(`Listing "`+prefix+`" was cancelled`, prefix, err)
	}
	memory.mutex.RLock()
	keys := make([]string, 0, len(memory.files))
	for key := range memory.files {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	memory.mutex.RUnlock()
	slices.Sort(keys)
	return keys, nil
}

type Filesystem struct {
	directory *Directory
}

func NewFilesystem(root string) (*Filesystem, error) {
	if strings.TrimSpace(root) == "" {
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"Filesystem persistence requires a non-empty directory path", nil)
	}
	directory, err := OpenDirectory(root)
	if err != nil {
		return nil, err
	}
	return &Filesystem{directory: directory}, nil
}

func (filesystem *Filesystem) Directory() *Directory {
	return filesystem.directory
}

func (filesystem *Filesystem) Save(ctx context.Context, key string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return saveFailed(`Saving "`+key+`" was cancelled`, key, err)
	}
	return filesystem.directory.AtomicWrite(key, data)
}

func (filesystem *Filesystem) Load(ctx context.Context, key string) ([]byte, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, loadFailed(`Loading "`+key+`" was cancelled`, key, err)
	}
	data, err := filesystem.directory.Read(key)
	if err != nil {
		return nil, false, err
	}
	return data, data != nil, nil
}

func (filesystem *Filesystem) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return deleteFailed(key, err)
	}
	return filesystem.directory.Remove(key)
}

func (filesystem *Filesystem) List(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, loadFailed(`Listing "`+prefix+`" was cancelled`, prefix, err)
	}
	return filesystem.directory.List(prefix)
}
