package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func (durable *Durable) RemoveHistory(ctx context.Context) error {
	directory := durable.manager.directory
	if directory == nil {
		return ctx.Err()
	}
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return removeHistory(directory, durable.handle.Name)
}

func (durable *Durable) CheckpointBytes(ctx context.Context) (uint64, error) {
	read, err := checkpoint.ReadManifest(ctx, durable.manager.store, durable.handle.Name)
	if err != nil || read.Kind != checkpoint.ManifestCurrent {
		return 0, err
	}
	var total uint64
	for _, file := range read.Manifest.Files() {
		total += file.Bytes
	}
	return total, nil
}
