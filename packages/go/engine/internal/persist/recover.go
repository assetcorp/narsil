package persist

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

func (manager *Manager) PersistedIndexes(ctx context.Context) ([]string, error) {
	keys, err := manager.store.List(ctx, "")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, key := range keys {
		if name, found := strings.CutSuffix(key, "/meta"); found && name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (manager *Manager) ReadMetadata(ctx context.Context, name string) (metadata.Metadata, bool, error) {
	data, found, err := manager.store.Read(ctx, metadataKey(name))
	if err != nil || !found {
		return metadata.Metadata{}, false, err
	}
	meta, _, err := metadata.Read(data)
	if err != nil {
		return metadata.Metadata{}, false, err
	}
	meta.VectorPromotion = raiseEarlierReleaseGraphM(meta.VectorPromotion)
	return meta, true, nil
}

func raiseEarlierReleaseGraphM(promotion *indexsettings.VectorPromotion) *indexsettings.VectorPromotion {
	if promotion == nil || promotion.HNSW == nil {
		return promotion
	}
	if m, set := promotion.HNSW.M.Get(); !set || m != EarlierReleaseMinGraphM {
		return promotion
	}
	raised := *promotion
	graph := *promotion.HNSW
	graph.M = model.Some(uint32(payload.MinM))
	raised.HNSW = &graph
	return &raised
}

func (manager *Manager) Recover(ctx context.Context) ([]*Durable, error) {
	if err := manager.finishRestoreJournals(ctx); err != nil {
		return nil, err
	}
	names, err := manager.PersistedIndexes(ctx)
	if err != nil {
		return nil, err
	}
	recovered := make([]*Durable, 0, len(names))
	for _, name := range names {
		durable, err := manager.RecoverIndex(ctx, name)
		if err != nil {
			return recovered, err
		}
		recovered = append(recovered, durable)
	}
	return recovered, nil
}

func (manager *Manager) RecoverIndex(ctx context.Context, name string) (*Durable, error) {
	meta, found, err := manager.ReadMetadata(ctx, name)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, narsilerr.New(narsilerr.CodeIndexNotFound, `Index "`+name+`" holds no durable metadata`,
			map[string]any{"indexName": name})
	}
	handle, err := manager.hooks.CreateIndex(ctx, meta)
	if err != nil {
		return nil, err
	}
	durable, err := manager.recoverHandle(ctx, handle)
	if err != nil {
		return nil, err
	}
	if err := manager.register(durable); err != nil {
		return nil, err
	}
	return durable, nil
}

func (manager *Manager) recoverHandle(ctx context.Context, handle *Handle) (*Durable, error) {
	durable, err := manager.recoverDurable(ctx, handle)
	if err == nil && manager.logged() {
		if err = manager.sizes.seedLog(manager.directory, handle.Name); err != nil {
			_ = durable.close()
		}
	}
	if err != nil {
		manager.sizes.forget(handle.Name)
		return nil, err
	}
	return durable, nil
}

func (manager *Manager) recoverDurable(ctx context.Context, handle *Handle) (*Durable, error) {
	applied, upgrade, err := manager.loadCheckpoint(ctx, manager.store, handle)
	if err != nil {
		return nil, err
	}
	if manager.logged() {
		if err := manager.replayLogs(ctx, handle, applied); err != nil {
			if upgrade != nil {
				manager.reportUpgrade(handle.Name, upgrade.layout, LayoutUpgradeFailed, err)
			}
			return nil, err
		}
	}
	durable := manager.newDurable(handle, applied)
	if upgrade == nil {
		return durable, nil
	}
	if err := durable.upgradeLayout(ctx, upgrade); err != nil {
		manager.reportUpgrade(handle.Name, upgrade.layout, LayoutUpgradeFailed, err)
		_ = durable.close()
		return nil, err
	}
	manager.reportUpgrade(handle.Name, upgrade.layout, LayoutUpgradeCompleted, nil)
	return durable, nil
}

func (manager *Manager) loadCheckpoint(ctx context.Context, store checkpoint.Store, handle *Handle) ([]uint64,
	*layoutUpgrade, error) {
	applied := make([]uint64, handle.Index.PartitionCount())
	read, err := checkpoint.ReadManifest(ctx, store, handle.Name)
	if err != nil {
		return nil, nil, err
	}
	keptForSync, err := manager.settleSyncAtRecovery(handle)
	if err != nil {
		return nil, nil, err
	}
	manager.sizes.recordSaved(handle.Name, savedSize{})
	switch read.Kind {
	case checkpoint.ManifestEarlier:
		manager.reportUpgrade(handle.Name, earlierManifestLayout, LayoutUpgradeStarted, nil)
		loaded, upgrade, err := manager.loadEarlierManifest(ctx, store, handle, read.Payload)
		if err != nil {
			manager.reportUpgrade(handle.Name, earlierManifestLayout, LayoutUpgradeFailed, err)
		}
		return loaded, upgrade, err
	case checkpoint.ManifestAbsent:
		bundle, bundled, err := store.Read(ctx, manifest.SnapshotBundleKey(handle.Name))
		if err != nil {
			return nil, nil, err
		}
		if bundled {
			manager.reportUpgrade(handle.Name, earlierBundleLayout, LayoutUpgradeStarted, nil)
			loaded, upgrade, err := manager.loadEarlierBundle(ctx, store, handle, bundle)
			if err != nil {
				manager.reportUpgrade(handle.Name, earlierBundleLayout, LayoutUpgradeFailed, err)
			}
			return loaded, upgrade, err
		}
		return applied, nil, checkpoint.ReclaimUnlisted(ctx, store, handle.Name, withSyncKept(map[string]struct{}{}, keptForSync))
	}
	if err := store.Remove(ctx, manifest.SnapshotBundleKey(handle.Name)); err != nil {
		return nil, nil, err
	}
	if err := checkpoint.ReclaimUnlisted(ctx, store, handle.Name, withSyncKept(checkpoint.ReferencedKeys(read.Manifest), keptForSync)); err != nil {
		return nil, nil, err
	}
	if err := LoadManifest(ctx, store, handle, read.Manifest); err != nil {
		return nil, nil, err
	}
	for partitionID := range applied {
		applied[partitionID] = read.Manifest.LastSeqNo(uint32(partitionID))
	}
	manager.sizes.recordSaved(handle.Name, savedSizeOf(read.Manifest))
	return applied, nil, nil
}

func LoadManifest(ctx context.Context, store checkpoint.Store, handle *Handle, listed manifest.Manifest) error {
	count := handle.Index.PartitionCount()
	pagedText := textStoredOnDisk(handle)
	for _, entry := range listed.Partitions {
		if int(entry.PartitionID) >= count {
			return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				"Segment manifest references partition "+strconv.FormatUint(uint64(entry.PartitionID), 10)+
					" beyond the partition count "+strconv.Itoa(count),
				map[string]any{"indexName": handle.Name, "partitionId": entry.PartitionID, "partitionCount": count})
		}
		for _, ref := range entry.Segments {
			if err := loadListedSegment(ctx, store, handle, int(entry.PartitionID), ref.File, listed.Schema); err != nil {
				return err
			}
		}
	}
	for _, ref := range listed.Vectors {
		field, declared := handle.Vectors[ref.FieldPath]
		if !declared {
			continue
		}
		dimension := -1
		if fieldType, listedField := listed.Schema[ref.FieldPath]; listedField {
			if parsed, err := schema.ParseFieldType(fieldType, ref.FieldPath); err == nil && parsed.Dimension > 0 {
				dimension = parsed.Dimension
			}
		}
		if field.Storage() == model.VectorStorageDisk {
			opened, err := openColdVectorField(ctx, store, ref, field, partitionResolver(handle))
			if err != nil {
				return err
			}
			if opened {
				continue
			}
		}
		if pagedText {
			if err := requireColdField(ctx, store, ref); err != nil {
				return err
			}
		}
		if err := checkpoint.LoadVectorField(ctx, store, ref, field, dimension); err != nil {
			return err
		}
	}
	return nil
}

func firstFailure(errs []error) error {
	for _, err := range errs {
		if err != nil {
			return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
				"A document from a checkpoint segment cannot be loaded")
		}
	}
	return nil
}

const textStorageDisk = "disk"

func textStoredOnDisk(handle *Handle) bool {
	if handle.Metadata == nil {
		return false
	}
	meta, err := handle.Metadata(uint64(handle.Index.Count()))
	if err != nil {
		return false
	}
	storage, set := meta.TextStorage.Get()
	return set && storage == textStorageDisk
}

func loadSegment(ctx context.Context, target *index.Index, attachTo int, segment checkpoint.StoredSegment) error {
	count := segment.DocumentTotal()
	stored := make([]string, count)
	for ordinal := range count {
		stored[ordinal] = segment.DocumentID(ordinal)
	}
	replaced, err := heldDocumentIDs(ctx, target, segment.RemovedIDs(), stored)
	if err != nil {
		return err
	}
	if err := applyInBatches(target, index.WriteRemove, removalsOf(replaced), firstFailure); err != nil {
		return err
	}
	if count > 0 && routesWhole(target, attachTo, segment) {
		if err := attachStored(target, attachTo, segment); err != nil {
			return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
				"A checkpoint segment cannot be attached to its partition")
		}
		return nil
	}
	inserted := make([]index.DocumentWrite, count)
	for ordinal := range count {
		fields, err := segment.StoredDocument(ordinal)
		if err != nil {
			return err
		}
		encoded, err := segment.EncodedDocument(ordinal)
		if err != nil {
			return err
		}
		inserted[ordinal] = index.DocumentWrite{ID: stored[ordinal], Fields: fields, Encoded: slices.Clone(encoded)}
	}
	return applyInBatches(target, index.WriteInsert, inserted, firstFailure)
}

type replayBuffer struct {
	ctx         context.Context
	handle      *Handle
	vectorPaths map[string]int
	pending     []Write
}

func (buffer *replayBuffer) add(entry wal.Entry) error {
	write, err := writeOfEntry(entry, buffer.vectorPaths)
	if err != nil {
		return err
	}
	buffer.pending = append(buffer.pending, write)
	if len(buffer.pending) >= RecoveryInsertBatchDocuments {
		return buffer.flush()
	}
	return nil
}

func (buffer *replayBuffer) flush() error {
	if len(buffer.pending) == 0 {
		return nil
	}
	pending := buffer.pending
	buffer.pending = nil
	failures, err := buffer.handle.apply(buffer.ctx, pending)
	if err != nil {
		return err
	}
	for at, failure := range failures {
		if failure != nil && narsilerr.CodeOf(failure) != narsilerr.CodeDocNotFound {
			return narsilerr.Wrap(narsilerr.CodePersistenceWalCorrupt,
				`The log record for document "`+pending[at].DocumentID+`" cannot be replayed`, failure, nil)
		}
	}
	return nil
}

func (manager *Manager) replayLogs(ctx context.Context, handle *Handle, applied []uint64) error {
	for partitionID := range applied {
		buffer := &replayBuffer{ctx: ctx, handle: handle, vectorPaths: handle.vectorPaths()}
		replayed, err := writeahead.Replay(manager.directory, handle.Name, uint32(partitionID), applied[partitionID],
			buffer.add)
		if err != nil {
			return err
		}
		if err := buffer.flush(); err != nil {
			return err
		}
		applied[partitionID] = replayed.HighestSeqNo
	}
	return writeahead.RemoveBeyondCount(manager.directory, handle.Name, len(applied))
}
