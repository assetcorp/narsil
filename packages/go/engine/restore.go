package engine

import (
	"context"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

// Restore replaces the index called indexName with the one that the snapshot
// archive in source holds, or creates it when no index has that name. The
// engine stages the archive first, so a damaged archive leaves the current
// index as it was and returns CodePersistenceLoadFailed or the code of the
// damage. Reads and writes keep reaching the current index while the engine
// stages the archive, and they wait only while it commits the staged files
// and swaps the restored index in, so a write made during the staging is
// replaced with the rest of the index. A closed index opens with the
// restored contents. An embedding adapter that the archive names binds when
// it is registered.
func (n *Narsil) Restore(ctx context.Context, indexName string, source io.Reader) error {
	ctx = callerctx.Shield(ctx)
	leave, err := n.enter()
	if err != nil {
		return err
	}
	ctx, publishWrites := n.deferWriteEvents(ctx)
	defer publishWrites()
	var notifications []model.Event
	defer func() { n.events.emitAll(notifications) }()
	defer n.emitWrite(indexName)
	defer leave()
	if err := validateIndexName(indexName); err != nil {
		return err
	}
	unlock, err := n.names.lockContext(ctx, indexName)
	if err != nil {
		return err
	}
	defer unlock()
	var created *indexEntry
	sink := n.newHistorySink(indexName)
	hooks := persist.RestoreHooks{
		Create: func(ctx context.Context, restoring persist.Restoring) (*persist.Handle, error) {
			stored := storedFromConfiguration(restoring.Configuration)
			stored.partitions = restoring.PartitionCount
			entry, err := n.entryFromStored(indexName, stored)
			if err != nil {
				return nil, err
			}
			created = entry
			n.inheritSync(entry)
			return sink.adopt(entry)
		},
		History: sink.open,
	}
	slot, previous := n.slotOf(indexName)
	replaces := previous != nil
	if replaces {
		endRestore := previous.beginRestore()
		defer endRestore()
	}
	swapping := false
	hooks.Swap = func(ctx context.Context) error {
		if replaces && !swapping {
			if err := previous.useMu.LockContext(ctx); err != nil {
				return err
			}
			swapping = true
		}
		return nil
	}
	defer func() {
		if swapping {
			previous.useMu.Unlock()
		}
	}()
	var durable *persist.Durable
	var installed persist.HistorySink
	if n.manager != nil {
		durable, installed, err = n.manager.RestoreArchive(ctx, indexName, source, hooks)
	} else {
		_, installed, err = persist.RestoreArchive(ctx, indexName, source, hooks)
	}
	if err != nil {
		if created != nil {
			created.dispose()
		}
		return err
	}
	if created == nil {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid snapshot archive: it holds no index", nil)
	}
	created.durable = durable
	if installed != nil {
		if err := installed.Install(ctx); err != nil {
			return err
		}
	}
	if err := hooks.Swap(ctx); err != nil {
		created.dispose()
		return err
	}
	if replaces {
		previous.retired = true
	}
	n.install(created)
	if swapping {
		previous.useMu.Unlock()
		swapping = false
	}
	if replaces {
		previous.dispose()
		previous.sync.changed.Notify()
	}
	if slot == nil {
		n.enforceOpenLimits(ctx, indexName)
	}
	n.afterSuggestionsRestore(ctx, sink, created)
	notifications = n.afterWrite(created)
	return n.releaseInheritedSync(ctx, created)
}

// Checkpoint saves the current state of the index called indexName to
// durable storage at once, so that recovery replays no log for the writes
// before it. Without durability configured, the call returns at once.
func (n *Narsil) Checkpoint(ctx context.Context, indexName string) error {
	ctx = callerctx.Shield(ctx)
	entry, release, err := n.acquireContext(ctx, indexName)
	if err != nil {
		return err
	}
	defer release()
	if entry.durable == nil {
		return ctx.Err()
	}
	return entry.durable.Checkpoint(ctx)
}

// Clear removes every document from the index called indexName and keeps its
// settings. With durability configured, the engine saves a checkpoint of the
// empty index before it returns.
func (n *Narsil) Clear(ctx context.Context, indexName string) error {
	ctx = callerctx.Shield(ctx)
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer n.emitWrite(indexName)
	defer release()
	releaseSync, err := n.holdRenewedSyncEpoch(ctx, entry)
	if err != nil {
		return err
	}
	defer releaseSync()
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	if err := entry.noteCleared(); err != nil {
		return err
	}
	if err := entry.index().Clear(entry.handle.NamedVectorFields()); err != nil {
		return err
	}
	entry.watermarkLatched = 0
	if entry.durable == nil {
		return nil
	}
	return entry.durable.CheckpointFromMemory(ctx)
}
