package persist

import (
	"context"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type SnapshotConfiguration func(listed manifest.Manifest) ([]byte, error)

func (handle *Handle) syncHistoryActive() bool {
	meta, err := handle.metadata(0)
	if err != nil {
		return false
	}
	active, _ := meta.SyncActive.Get()
	return meta.Sync != nil && meta.Sync.Enabled && active
}

func (durable *Durable) truncateCovered(seqNos []uint64) error {
	directory, name := durable.manager.directory, durable.handle.Name
	keepsHistory := durable.handle.syncHistoryActive()
	movedAtMs := uint64(time.Now().UnixMilli())
	for partitionID, seqNo := range seqNos {
		retire := func(segment writeahead.SegmentRef) error { return directory.Remove(segment.Key) }
		if keepsHistory {
			retire = func(segment writeahead.SegmentRef) error {
				return directory.Move(segment.Key, historyKey(name, uint32(partitionID), segment.StartSeqNo, movedAtMs))
			}
		}
		if err := writeahead.RetireCovered(directory, name, uint32(partitionID), seqNo, retire); err != nil {
			return err
		}
	}
	if keepsHistory && durable.handle.SyncHistoryMoved != nil {
		durable.handle.SyncHistoryMoved()
	}
	return nil
}

func (durable *Durable) publishedIfActive() (*PublishedSnapshot, error) {
	if durable.manager.directory == nil || !durable.handle.syncHistoryActive() {
		return nil, nil
	}
	return readPublishedSnapshot(durable.manager.directory, durable.handle.Name)
}

func (durable *Durable) withoutSyncKept(garbage []string) ([]string, error) {
	published, err := durable.publishedIfActive()
	if err != nil || published == nil {
		return garbage, err
	}
	kept := make([]string, 0, len(garbage))
	for _, key := range garbage {
		if _, listed := published.Keys[key]; !listed {
			kept = append(kept, key)
		}
	}
	return kept, nil
}

func (durable *Durable) removeGarbage(ctx context.Context, store checkpoint.Store, garbage []string) error {
	removable, err := durable.withoutSyncKept(garbage)
	if err != nil {
		return err
	}
	return checkpoint.RemoveGarbage(ctx, store, removable, durable.handle.vectorFields())
}

func (manager *Manager) settleSyncAtRecovery(handle *Handle) (map[string]struct{}, error) {
	directory := manager.directory
	if directory == nil {
		return nil, nil
	}
	name := handle.Name
	publishedKey := publishedSnapshotKey(name)
	keys, err := directory.List(syncDirectoryPrefix(name))
	if err != nil {
		return nil, err
	}
	for _, key := range keys {
		if key == publishedKey {
			continue
		}
		if err := directory.Remove(key); err != nil {
			return nil, err
		}
	}
	if !handle.syncHistoryActive() {
		if err := directory.Remove(publishedKey); err != nil {
			return nil, err
		}
		return nil, removeHistory(directory, name)
	}
	published, err := readPublishedSnapshot(directory, name)
	if err != nil {
		return nil, directory.Remove(publishedKey)
	}
	if published == nil {
		return nil, nil
	}
	return published.Keys, nil
}

func withSyncKept(referenced map[string]struct{}, kept map[string]struct{}) map[string]struct{} {
	for key := range kept {
		referenced[key] = struct{}{}
	}
	return referenced
}

func (durable *Durable) removeUnlisted(ctx context.Context, previous map[string]struct{}, kept map[string]struct{}) error {
	read, err := checkpoint.ReadManifest(ctx, durable.manager.store, durable.handle.Name)
	if err != nil {
		return err
	}
	current := map[string]struct{}{}
	if read.Kind == checkpoint.ManifestCurrent {
		current = checkpoint.ReferencedKeys(read.Manifest)
	}
	for key := range previous {
		_, stillPublished := kept[key]
		_, stillListed := current[key]
		if stillPublished || stillListed {
			continue
		}
		if err := durable.manager.directory.Remove(key); err != nil {
			return err
		}
	}
	return nil
}

func (durable *Durable) ReleaseSync(ctx context.Context) error {
	directory := durable.manager.directory
	if directory == nil {
		return ctx.Err()
	}
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	name := durable.handle.Name
	previous, readErr := readPublishedSnapshot(directory, name)
	if err := directory.Remove(publishedSnapshotKey(name)); err != nil {
		return err
	}
	if readErr == nil && previous != nil {
		if err := durable.removeUnlisted(ctx, previous.Keys, nil); err != nil {
			return err
		}
	}
	return removeHistory(directory, name)
}

func (durable *Durable) Published(ctx context.Context) (*PublishedSnapshot, error) {
	if err := ctx.Err(); err != nil || durable.manager.directory == nil {
		return nil, err
	}
	return readPublishedSnapshot(durable.manager.directory, durable.handle.Name)
}

func (durable *Durable) PublishSync(ctx context.Context, configurationOf SnapshotConfiguration) (*PublishedSnapshot, error) {
	opened, err := durable.OpenArchive(ctx)
	if err != nil {
		return nil, err
	}
	defer opened.Release()
	config, err := configurationOf(opened.Manifest)
	if err != nil {
		return nil, err
	}
	directory, name := durable.manager.directory, durable.handle.Name
	previous, readErr := readPublishedSnapshot(directory, name)
	next, err := writePublishedSnapshot(directory, name, config, opened.manifestBytes)
	if err != nil {
		return nil, err
	}
	if readErr != nil || previous == nil {
		return next, nil
	}
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	return next, durable.removeUnlisted(ctx, previous.Keys, next.Keys)
}
