package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func (durable *Durable) upgradeLayout(ctx context.Context, upgrade *layoutUpgrade) error {
	for _, field := range durable.handle.vectorFields() {
		if err := field.CompleteGraph(ctx); err != nil {
			return err
		}
	}
	written, err := durable.checkpointWith(ctx, checkpointOptions{everyPartition: true, prior: &upgrade.prior})
	if err != nil {
		return err
	}
	store := durable.manager.store
	listed := checkpoint.ReferencedKeys(written)
	for _, key := range upgrade.earlierKeys {
		if _, kept := listed[key]; kept {
			continue
		}
		if err := store.Remove(ctx, key); err != nil {
			return err
		}
	}
	return store.Remove(ctx, manifest.SnapshotBundleKey(durable.handle.Name))
}
