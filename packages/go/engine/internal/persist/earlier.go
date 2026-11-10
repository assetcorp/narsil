package persist

import (
	"context"
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/earlier"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type LayoutUpgradeStatus string

const (
	LayoutUpgradeStarted   LayoutUpgradeStatus = "started"
	LayoutUpgradeCompleted LayoutUpgradeStatus = "completed"
	LayoutUpgradeFailed    LayoutUpgradeStatus = "failed"
)

type LayoutUpgradeEvent struct {
	IndexName string
	Status    LayoutUpgradeStatus
	Layout    string
	Err       error
}

const (
	earlierManifestLayout = "manifest"
	earlierBundleLayout   = "bundle"
)

type layoutUpgrade struct {
	layout      string
	prior       manifest.Manifest
	earlierKeys []string
}

func (manager *Manager) reportUpgrade(name string, layout string, status LayoutUpgradeStatus, err error) {
	if manager.hooks.OnLayoutUpgrade != nil {
		manager.hooks.OnLayoutUpgrade(LayoutUpgradeEvent{IndexName: name, Status: status, Layout: layout, Err: err})
	}
}

func appliedFrom(checkpoints []manifest.PartitionCheckpoint, count int) []uint64 {
	applied := make([]uint64, count)
	for _, entry := range checkpoints {
		if int(entry.PartitionID) < count {
			applied[entry.PartitionID] = entry.LastSeqNo
		}
	}
	return applied
}

func earlierLoadFailed(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, details)
}

func readEarlierFile(ctx context.Context, store checkpoint.Store, key string, what string) ([]byte, error) {
	data, found, err := store.Read(ctx, key)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, earlierLoadFailed("The "+what+` "`+key+`" is missing`, map[string]any{"key": key})
	}
	return data, nil
}

func addSegmentSchema(agreed map[string]string, found map[string]string) error {
	for field, fieldType := range found {
		if existing, held := agreed[field]; held && existing != fieldType {
			return earlierLoadFailed(`Segment schemas disagree on field "`+field+`": "`+existing+`" vs "`+fieldType+`"`,
				map[string]any{"field": field, "existing": existing, "found": fieldType})
		}
		agreed[field] = fieldType
	}
	return nil
}

func sortedDocumentIDs(documents map[string]map[string]any) []string {
	ids := make([]string, 0, len(documents))
	for id := range documents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func replaceEarlierDocuments(handle *Handle, tombstones []string, documents map[string]map[string]any) error {
	ids := sortedDocumentIDs(documents)
	replaced := make([]string, 0, len(tombstones))
	for _, id := range tombstones {
		if handle.Index.Has(id) {
			replaced = append(replaced, id)
		}
	}
	for _, id := range ids {
		if handle.Index.Has(id) {
			replaced = append(replaced, id)
		}
	}
	for start := 0; start < len(replaced); start += RecoveryInsertBatchDocuments {
		end := min(start+RecoveryInsertBatchDocuments, len(replaced))
		if err := firstFailure(handle.Index.Remove(replaced[start:end])); err != nil {
			return err
		}
	}
	batch := make([]partition.Document, 0, min(len(ids), RecoveryInsertBatchDocuments))
	for at, id := range ids {
		batch = append(batch, partition.Document{ID: id, Fields: documents[id]})
		if len(batch) == RecoveryInsertBatchDocuments || at == len(ids)-1 {
			if err := firstFailure(handle.Index.Insert(batch)); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	return nil
}

func earlierReferencedKeys(listed earlier.Manifest) map[string]struct{} {
	keys := map[string]struct{}{}
	for _, entry := range listed.Partitions {
		for _, segment := range entry.Segments {
			keys[segment.Key] = struct{}{}
		}
	}
	for _, field := range listed.Vectors {
		for _, file := range field.Files {
			keys[file.Key] = struct{}{}
		}
		if key, present := field.GraphKey.Get(); present {
			keys[key] = struct{}{}
		}
	}
	return keys
}

func loadEarlierPartition(ctx context.Context, store checkpoint.Store, handle *Handle,
	entry earlier.PartitionEntry) error {
	agreed := map[string]string{}
	for _, ref := range entry.Segments {
		data, err := readEarlierFile(ctx, store, ref.Key, "segment file")
		if err != nil {
			return err
		}
		segment, err := earlier.DecodeSegment(data)
		if err != nil {
			return err
		}
		stored, err := earlier.DecodePartitionDocuments(segment.Payload)
		if err != nil {
			return err
		}
		if err := addSegmentSchema(agreed, stored.Schema); err != nil {
			return err
		}
		if err := replaceEarlierDocuments(handle, segment.Tombstones, stored.Documents); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) loadEarlierManifest(ctx context.Context, store checkpoint.Store, handle *Handle,
	payload map[string]any) ([]uint64, *layoutUpgrade, error) {
	listed, err := earlier.DecodeManifest(payload)
	if err != nil {
		return nil, nil, err
	}
	referenced := earlierReferencedKeys(listed)
	if err := checkpoint.ReclaimUnlisted(ctx, store, handle.Name, referenced); err != nil {
		return nil, nil, err
	}
	count := handle.Index.PartitionCount()
	for _, entry := range listed.Partitions {
		if int(entry.PartitionID) >= count {
			return nil, nil, earlierLoadFailed("Segment manifest references partition "+
				strconv.FormatUint(uint64(entry.PartitionID), 10)+" beyond the partition count "+strconv.Itoa(count),
				map[string]any{"indexName": handle.Name, "partitionId": entry.PartitionID})
		}
		if err := loadEarlierPartition(ctx, store, handle, entry); err != nil {
			return nil, nil, err
		}
	}
	upgrade := &layoutUpgrade{layout: earlierManifestLayout, prior: manifest.Manifest{Schema: listed.Schema,
		Language: listed.Language, Checkpoint: []manifest.PartitionCheckpoint{}}}
	for _, entry := range listed.Partitions {
		upgrade.prior.Partitions = append(upgrade.prior.Partitions, manifest.PartitionEntry{
			PartitionID: entry.PartitionID, NextSegmentID: entry.NextSegmentID, Segments: []manifest.SegmentRef{}})
		for _, segment := range entry.Segments {
			upgrade.earlierKeys = append(upgrade.earlierKeys, segment.Key)
		}
	}
	for _, ref := range listed.Vectors {
		if graphKey, present := ref.GraphKey.Get(); present {
			upgrade.earlierKeys = append(upgrade.earlierKeys, graphKey)
		}
		field, declared := handle.Vectors[ref.FieldPath]
		if !declared {
			for _, file := range ref.Files {
				upgrade.earlierKeys = append(upgrade.earlierKeys, file.Key)
			}
			continue
		}
		prior, err := loadEarlierVectorField(ctx, store, ref, field)
		if err != nil {
			return nil, nil, err
		}
		upgrade.prior.Vectors = append(upgrade.prior.Vectors, prior)
	}
	return appliedFrom(listed.Checkpoint, count), upgrade, nil
}

func (manager *Manager) loadEarlierBundle(ctx context.Context, store checkpoint.Store, handle *Handle,
	data []byte) ([]uint64, *layoutUpgrade, error) {
	bundle, err := earlier.DecodeBundle(data)
	if err != nil {
		return nil, nil, err
	}
	if err := checkpoint.ReclaimUnlisted(ctx, store, handle.Name, map[string]struct{}{}); err != nil {
		return nil, nil, err
	}
	if err := insertEarlierDocuments(handle, bundle.Partitions, bundle.VectorIndexes); err != nil {
		return nil, nil, err
	}
	upgrade := &layoutUpgrade{layout: earlierBundleLayout, prior: manifest.Manifest{Schema: bundle.Schema,
		Language: bundle.Language, Checkpoint: []manifest.PartitionCheckpoint{}}}
	return appliedFrom(bundle.Checkpoint, handle.Index.PartitionCount()), upgrade, nil
}
