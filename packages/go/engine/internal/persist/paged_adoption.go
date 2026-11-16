package persist

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func (held *capture) trackChanges(ctx context.Context, handle *Handle) error {
	tokens := handle.Index.BorrowableTokens()
	if tokens != nil {
		for partitionID := range handle.Index.PartitionCount() {
			held.unwatch = append(held.unwatch, handle.Index.WatchWrites(partitionID, tokens))
		}
	}
	changes, err := handle.Index.TrackChanges(ctx)
	if err != nil {
		held.stopWatching()
		return err
	}
	held.changes, held.tracked, held.tokens = changes, handle.Index, tokens
	return nil
}

func (held *capture) stopWatching() {
	for _, unwatch := range held.unwatch {
		unwatch()
	}
	held.unwatch = nil
}

func (held capture) stopTracking() {
	held.stopWatching()
	if held.tracked != nil {
		_ = held.tracked.StopTracking(context.Background(), held.changes)
	}
}

func (durable *Durable) adoptsPartition(held capture, partitionID int) bool {
	if held.whole[partitionID] {
		return true
	}
	return (held.logged[partitionID] || held.rewritten[uint32(partitionID)]) &&
		held.changes[partitionID].Clears() == durable.partitions[partitionID].clearsCovered
}

type pendingAdoption struct {
	target      *index.Index
	entry       manifest.PartitionEntry
	partitionID int
	log         *partitionLog
	changes     *partition.ChangeLog
	tokens      *analysis.Pass
}

func (durable *Durable) adoptionsOf(listed manifest.Manifest, held capture) []pendingAdoption {
	if held.tracked == nil || held.tracked != durable.handle.Index || held.left != 0 {
		return nil
	}
	var adoptions []pendingAdoption
	for _, entry := range listed.Partitions {
		partitionID := int(entry.PartitionID)
		if partitionID >= len(held.changes) || partitionID >= len(durable.partitions) ||
			!durable.adoptsPartition(held, partitionID) {
			continue
		}
		adoptions = append(adoptions, pendingAdoption{target: held.tracked, entry: entry, partitionID: partitionID,
			log: durable.partitions[partitionID], changes: held.changes[partitionID], tokens: held.tokens})
	}
	return adoptions
}

func (durable *Durable) adoptAll(ctx context.Context, store checkpoint.Store, adoptions []pendingAdoption) error {
	for _, adoption := range adoptions {
		if err := durable.adoptPartition(ctx, store, adoption); err != nil {
			return err
		}
	}
	return nil
}

func (durable *Durable) noteClearsCovered(held capture) {
	if held.tracked == nil || held.tracked != durable.handle.Index {
		return
	}
	for partitionID, whole := range held.whole {
		if whole && partitionID < len(durable.partitions) && partitionID < len(held.changes) {
			durable.partitions[partitionID].clearsCovered = held.changes[partitionID].Clears()
		}
	}
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
		path, onDisk, err := checkpoint.ListedPagedPath(ctx, store, ref.File)
		if err != nil || !onDisk {
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
		opened, err := segments.OpenPaged(w, path, pages, paged.SharedReadCache())
		w.Release()
		if err != nil {
			return false, err
		}
		files.opened = append(files.opened, opened)
		files.paged, files.kept = append(files.paged, opened), append(files.kept, false)
	}
	return true, nil
}

func (durable *Durable) preparedAdoption(ctx context.Context, store checkpoint.Store, target *index.Index,
	entry manifest.PartitionEntry, partitionID int, tokens *analysis.Pass) (*partition.Adoption, *adoptionFiles, bool) {
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
		adoption, err = target.PrepareAdoption(partitionID, files.paged, files.kept, tokens)
	}
	if err != nil || !listed {
		files.closeOpened()
		files.closeHeld()
		return nil, nil, false
	}
	return adoption, files, true
}

func (durable *Durable) adoptPartition(ctx context.Context, store checkpoint.Store, pending pendingAdoption) error {
	target, partitionID, tokens := pending.target, pending.partitionID, pending.tokens
	if tokens == nil {
		var err error
		if tokens, err = target.WriteTokens(); err != nil {
			return nil
		}
		defer target.WatchWrites(partitionID, tokens)()
	}
	adoption, files, ready := durable.preparedAdoption(ctx, store, target, pending.entry, partitionID, tokens)
	if !ready {
		return ctx.Err()
	}
	defer files.closeHeld()
	for round := 1; ; round++ {
		tokens.AbsorbBorrowed()
		adopted, err := target.Adopt(ctx, partitionID, adoption, pending.changes, tokens)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			files.closeOpened()
			return err
		}
		var missed *analysis.MissedTokens
		if errors.As(err, &missed) && round < partition.TokenRoundsPerWrite {
			tokens.Remember(missed.Sources)
			continue
		}
		if !adopted || errors.As(err, &missed) {
			files.closeOpened()
			return nil
		}
		if err != nil {
			return durable.failAdoption(pending.log, err)
		}
		return nil
	}
}

func (durable *Durable) failAdoption(log *partitionLog, cause error) error {
	failure := narsilerr.Passthrough(cause, narsilerr.CodePersistenceSaveFailed,
		`Index "`+durable.handle.Name+`" cannot move the text of its checkpoint onto disk, so it refuses writes until a restart recovers it from that checkpoint`)
	log.mutex.Lock()
	log.failed = failure
	log.mutex.Unlock()
	durable.manager.markFatal(failure)
	return failure
}
