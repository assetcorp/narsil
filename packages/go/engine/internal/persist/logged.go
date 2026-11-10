package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/segment"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type loggedChanges struct {
	live    map[string]map[string]any
	deleted map[string]struct{}
}

func (changes loggedChanges) tombstones() []string {
	tombstones := make([]string, 0, len(changes.deleted))
	for id := range changes.deleted {
		if _, live := changes.live[id]; !live {
			tombstones = append(tombstones, id)
		}
	}
	sort.Strings(tombstones)
	return tombstones
}

func firstSaveFailure(errs []error) error {
	for _, err := range errs {
		if err != nil {
			return narsilerr.Passthrough(err, narsilerr.CodePersistenceSaveFailed,
				"A document cannot be written into a checkpoint segment")
		}
	}
	return nil
}

func (durable *Durable) readLoggedChanges(partitionID int, from uint64, to uint64) (loggedChanges, error) {
	changes := loggedChanges{live: map[string]map[string]any{}, deleted: map[string]struct{}{}}
	vectorPaths := durable.handle.vectorPaths()
	err := writeahead.ReadRange(durable.manager.directory, durable.handle.Name, uint32(partitionID), from, to,
		func(entry wal.Entry) error {
			write, err := writeOfEntry(entry, vectorPaths)
			if err != nil {
				return err
			}
			if write.Document == nil {
				delete(changes.live, write.DocumentID)
				changes.deleted[write.DocumentID] = struct{}{}
				return nil
			}
			changes.live[write.DocumentID] = write.Document
			return nil
		})
	return changes, err
}

func detachedIndexOf(handle *Handle) (*index.Index, error) {
	if handle.NewDetachedIndex == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+handle.Name+`" has no way to build a checkpoint segment apart from its live index`,
			map[string]any{"indexName": handle.Name})
	}
	detached, err := handle.NewDetachedIndex()
	if err != nil {
		return nil, err
	}
	if detached.PartitionCount() != 1 {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			`The detached index of "`+handle.Name+`" must hold exactly one partition`,
			map[string]any{"indexName": handle.Name, "partitionCount": detached.PartitionCount()})
	}
	return detached, nil
}

func insertDocuments(target *index.Index, documents map[string]map[string]any) error {
	ids := sortedDocumentIDs(documents)
	batch := make([]partition.Document, 0, min(len(ids), RecoveryInsertBatchDocuments))
	for at, id := range ids {
		batch = append(batch, partition.Document{ID: id, Fields: documents[id]})
		if len(batch) == RecoveryInsertBatchDocuments || at == len(ids)-1 {
			if err := firstSaveFailure(target.Insert(batch)); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	return nil
}

func segmentsOfDetached(detached *index.Index, options segment.BuildOptions) ([]*keyword.Segment, error) {
	var built []*keyword.Segment
	err := detached.ReadPartition(0, func(view partition.View) error {
		segments, err := segment.Build(view, options)
		built = segments
		return err
	})
	return built, err
}

func priorEntryOf(prior *manifest.Manifest, partitionID int) manifest.PartitionEntry {
	if prior != nil {
		for _, entry := range prior.Partitions {
			if entry.PartitionID == uint32(partitionID) {
				copied := entry
				copied.Segments = append([]manifest.SegmentRef{}, entry.Segments...)
				return copied
			}
		}
	}
	return manifest.PartitionEntry{PartitionID: uint32(partitionID), Segments: []manifest.SegmentRef{}}
}

func priorSeqNoOf(prior *manifest.Manifest, partitionID int) uint64 {
	if prior == nil {
		return 0
	}
	return prior.LastSeqNo(uint32(partitionID))
}

func (durable *Durable) writeLoggedPartition(ctx context.Context, store checkpoint.Store, prior *manifest.Manifest,
	partitionID int, to uint64) (manifest.PartitionEntry, error) {
	entry := priorEntryOf(prior, partitionID)
	changes, err := durable.readLoggedChanges(partitionID, priorSeqNoOf(prior, partitionID), to)
	if err != nil {
		return entry, err
	}
	tombstones := changes.tombstones()
	if len(changes.live) == 0 && len(tombstones) == 0 {
		return entry, nil
	}
	detached, err := detachedIndexOf(durable.handle)
	if err != nil {
		return entry, err
	}
	if err := insertDocuments(detached, changes.live); err != nil {
		return entry, err
	}
	options := segment.BuildOptions{Schema: flatSchema(durable.handle),
		TargetBytes: durable.manager.settings.TargetSegmentBytes, Tombstones: tombstones, KeepsEmpty: true}
	built, err := segmentsOfDetached(detached, options)
	if err != nil {
		return entry, err
	}
	pagedText := durable.textStoredOnDisk()
	if pagedText && len(built) > 0 {
		marked, err := pagedTombstonesFor(ctx, store, entry.Segments, built, tombstones)
		if err != nil {
			return entry, err
		}
		built[0].Tombstones = marked
	}
	return entry, checkpoint.AppendSegments(ctx, store, durable.handle.Name, &entry, built, pagedText)
}
