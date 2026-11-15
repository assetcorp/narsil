package persist

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

const archivePinPrefix = ".archive-"

func (manager *Manager) pinArchive(ctx context.Context, name string, keys []string) (checkpoint.Store, func(), error) {
	restore := manager.restoreStorage()
	pinned := stagedStore{base: manager.store, root: name + "/", prefix: archivePinPrefix + randomSuffix() + "/"}
	var once sync.Once
	release := func() {
		once.Do(func() { _ = removePrefix(context.WithoutCancel(ctx), restore, pinned.prefix) })
	}
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if _, repeated := seen[key]; repeated {
			continue
		}
		seen[key] = struct{}{}
		target, err := pinned.staged(key)
		if err == nil {
			err = manager.pinFile(ctx, key, target)
		}
		if err != nil {
			release()
			return nil, nil, err
		}
	}
	return pinned, release, nil
}

func (manager *Manager) pinFile(ctx context.Context, key string, target string) error {
	if manager.directory != nil {
		return manager.directory.Link(key, target)
	}
	data, found, err := manager.store.Read(ctx, key)
	if err != nil {
		return err
	}
	if !found {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The checkpoint file "`+key+`" that the manifest lists is missing`, map[string]any{"key": key})
	}
	return manager.store.Write(ctx, target, data)
}
