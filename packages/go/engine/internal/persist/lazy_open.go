package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (manager *Manager) RecoverMetadata(ctx context.Context) ([]metadata.Metadata, error) {
	if err := manager.finishRestoreJournals(ctx); err != nil {
		return nil, err
	}
	names, err := manager.PersistedIndexes(ctx)
	if err != nil {
		return nil, err
	}
	described := make([]metadata.Metadata, 0, len(names))
	for _, name := range names {
		meta, found, err := manager.ReadMetadata(ctx, name)
		if err != nil {
			return nil, err
		}
		if found {
			described = append(described, meta)
		}
	}
	return described, nil
}

func (manager *Manager) RemoveClosedIndex(ctx context.Context, name string) error {
	if _, open := manager.Get(name); open {
		return narsilerr.New(narsilerr.CodeConfigInvalid, `Index "`+name+`" is open, so the engine cannot remove its files without closing it`,
			map[string]any{"indexName": name})
	}
	return manager.removeIndexKeys(ctx, name)
}
