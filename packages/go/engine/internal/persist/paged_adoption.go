package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func (held *capture) trackChanges(handle *Handle) error {
	changes, err := handle.Index.TrackChanges()
	if err != nil {
		return err
	}
	held.changes, held.tracked = changes, handle.Index
	return nil
}

func (held capture) stopTracking() {
	if held.tracked != nil {
		_ = held.tracked.StopTracking(held.changes)
	}
}

func (durable *Durable) adoptsPartition(held capture, partitionID int) bool {
	if held.whole[partitionID] {
		return true
	}
	return (held.logged[partitionID] || held.rewritten[uint32(partitionID)]) &&
		held.changes[partitionID].Clears() == durable.partitions[partitionID].clearsCovered
}

func (durable *Durable) adoptWritten(ctx context.Context, store checkpoint.Store, listed manifest.Manifest,
	held capture) error {
	if held.tracked == nil || held.tracked != durable.handle.Index {
		return nil
	}
	if held.left == 0 {
		for _, entry := range listed.Partitions {
			partitionID := int(entry.PartitionID)
			if partitionID >= len(held.changes) || partitionID >= len(durable.partitions) ||
				!durable.adoptsPartition(held, partitionID) {
				continue
			}
			if err := durable.adoptPartition(ctx, store, entry, partitionID, held.changes[partitionID]); err != nil {
				return err
			}
		}
	}
	for partitionID, whole := range held.whole {
		if whole && partitionID < len(durable.partitions) {
			durable.partitions[partitionID].clearsCovered = held.changes[partitionID].Clears()
		}
	}
	return nil
}

type adoptionFiles struct {
	held   map[string]*segments.Paged
	opened []*segments.Paged
	paged  []*segments.Paged
	kept   []bool
}

func (files *adoptionFiles) closeHeld() {
	for _, paged := range files.held {
		paged.Close()
	}
}

func (files *adoptionFiles) closeOpened() {
	for _, paged := range files.opened {
		paged.Close()
	}
}

func (files *adoptionFiles) open(ctx context.Context, store checkpoint.Store, refs []manifest.SegmentRef,
	pages *core.PageCache) (bool, error) {
	for _, ref := range refs {
		path, paged, err := checkpoint.ListedPagedPath(ctx, store, ref.File)
		if err != nil || !paged {
			return false, err
		}
		if existing, found := files.held[path]; found {
			files.paged, files.kept = append(files.paged, existing), append(files.kept, true)
			continue
		}
		w, err := core.AcquireWorkspace()
		if err != nil {
			return false, err
		}
		opened, err := segments.OpenPaged(w, path, pages)
		w.Release()
		if err != nil {
			return false, err
		}
		files.opened = append(files.opened, opened)
		files.paged, files.kept = append(files.paged, opened), append(files.kept, false)
	}
	return true, nil
}

func (durable *Durable) preparedAdoption(ctx context.Context, store checkpoint.Store, entry manifest.PartitionEntry,
	partitionID int) (*partition.Adoption, *adoptionFiles, bool) {
	target := durable.handle.Index
	pages, err := durable.handle.removalPages.get()
	if err != nil {
		return nil, nil, false
	}
	held, err := target.HeldPagedSegments(ctx, partitionID)
	if err != nil {
		return nil, nil, false
	}
	files := &adoptionFiles{held: held}
	listed, err := files.open(ctx, store, entry.Segments, pages)
	var adoption *partition.Adoption
	if err == nil && listed {
		adoption, err = target.PrepareAdoption(partitionID, files.paged, files.kept)
	}
	if err != nil || !listed {
		files.closeOpened()
		files.closeHeld()
		return nil, nil, false
	}
	return adoption, files, true
}

func (durable *Durable) adoptPartition(ctx context.Context, store checkpoint.Store, entry manifest.PartitionEntry,
	partitionID int, log *partition.ChangeLog) error {
	adoption, files, ready := durable.preparedAdoption(ctx, store, entry, partitionID)
	if !ready {
		return nil
	}
	defer files.closeHeld()
	adopted, err := durable.handle.Index.Adopt(partitionID, adoption, log)
	if !adopted {
		files.closeOpened()
		return nil
	}
	if err != nil {
		return durable.failAdoption(partitionID, err)
	}
	return nil
}

func (durable *Durable) failAdoption(partitionID int, cause error) error {
	failure := narsilerr.Passthrough(cause, narsilerr.CodePersistenceSaveFailed,
		`Index "`+durable.handle.Name+`" cannot move the text of its checkpoint onto disk, so it refuses writes until a restart recovers it from that checkpoint`)
	log := durable.partitions[partitionID]
	log.mutex.Lock()
	log.failed = failure
	log.mutex.Unlock()
	durable.manager.markFatal(failure)
	return failure
}
