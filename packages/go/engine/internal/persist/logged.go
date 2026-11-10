package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type loggedChanges struct {
	live    map[string]Write
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
	changes := loggedChanges{live: map[string]Write{}, deleted: map[string]struct{}{}}
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
			changes.live[write.DocumentID] = write
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

func insertDocuments(target *index.Index, documents map[string]Write) error {
	ids := sortedKeys(documents)
	inserted := make([]index.DocumentWrite, len(ids))
	for at, id := range ids {
		inserted[at] = index.DocumentWrite{ID: id, Fields: documents[id].Document, Encoded: documents[id].Encoded}
	}
	return applyInBatches(target, index.WriteInsert, inserted, firstSaveFailure)
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
	defer detached.Release()
	if err := insertDocuments(detached, changes.live); err != nil {
		return entry, err
	}
	pagedText := durable.textStoredOnDisk()
	if pagedText {
		if tombstones, err = pagedTombstonesFor(ctx, store, entry.Segments, sortedKeys(changes.live),
			tombstones); err != nil {
			return entry, err
		}
	}
	return entry, writePartitionSegments(ctx, store, durable.handle.Name, detached, &entry,
		segmentWriteRequest{schema: flatSchema(durable.handle), schemaOrder: schemaOrderOf(durable.handle),
			tombstones: tombstones}, pagedText)
}
