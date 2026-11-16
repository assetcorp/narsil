package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func (manager *Manager) settleStoredPartitions(ctx context.Context, name string, meta *metadata.Metadata) error {
	read, err := checkpoint.ReadManifest(ctx, manager.store, name)
	if err != nil || read.Kind != checkpoint.ManifestCurrent {
		return err
	}
	listed := read.Manifest
	count := len(listed.Checkpoint)
	invalid := func() error {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The checkpoint must list every live partition in order from zero",
			map[string]any{"indexName": name})
	}
	if count == 0 || count > manifest.MaxPartitionID+1 || len(listed.Partitions) != count {
		return invalid()
	}
	for at, head := range listed.Checkpoint {
		if head.PartitionID != uint32(at) {
			return invalid()
		}
	}
	for _, partition := range listed.Partitions {
		if uint64(partition.PartitionID) >= uint64(count) {
			return invalid()
		}
	}
	if meta.PartitionCount == uint32(count) {
		return nil
	}
	meta.PartitionCount = uint32(count)
	encoded, err := metadata.Write(*meta, false, true)
	if err != nil {
		return err
	}
	return manager.store.Write(ctx, metadataKey(name), encoded)
}
