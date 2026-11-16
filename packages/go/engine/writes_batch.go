package engine

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/callerctx"
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type batchOutcome struct {
	result        model.BatchResult
	touched       touchedVectors
	memoryRefusal error
	refusedDocID  string
}

func newBatchOutcome() *batchOutcome {
	return &batchOutcome{result: model.BatchResult{Succeeded: []string{}, Failed: []model.BatchFailure{}},
		touched: touchedVectors{}}
}

func cancelledBatch(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func (outcome *batchOutcome) fail(id string, err error) {
	outcome.result.Failed = append(outcome.result.Failed, model.BatchFailure{DocID: id, Err: engineErrorOf(err)})
}

func requireDocument(document *model.Document) error {
	if document == nil {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Each document must be an object, while this entry is null",
			map[string]any{"received": "null"})
	}
	return nil
}

func eachBatchChunk[T any](ctx context.Context, entries []T, apply func(chunk []T) error,
	failFrom func(from int, err error)) error {
	for start := 0; start < len(entries); start += batchChunkSize {
		if err := ctx.Err(); err != nil {
			failFrom(start, err)
			return err
		}
		end := min(start+batchChunkSize, len(entries))
		if err := apply(entries[start:end]); err != nil {
			failFrom(end, err)
			return err
		}
	}
	return nil
}

// UpdateBatch replaces the stored document of each entry of updates in the
// index called indexName, in chunks of 1,000, and reports each one the same
// way as InsertBatch. An entry whose ID holds no document fails with
// CodeDocNotFound.
func (n *Narsil) UpdateBatch(ctx context.Context, indexName string, updates []DocumentUpdate, options WriteOptions) (BatchResult, error) {
	ctx = callerctx.Shield(ctx)
	entry, release, err := n.acquireContext(ctx, indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer n.emitWrite(indexName)
	var notifications []model.Event
	defer func() { n.events.emitAll(notifications) }()
	defer func() { release() }()
	if err := n.memory.refuseWhileFull(indexName); err != nil {
		return model.BatchResult{}, err
	}
	outcome := newBatchOutcome()
	defer func() {
		if entry != nil {
			entry.scheduleVectorBuilds(outcome.touched)
		}
	}()
	entry, release, err = n.updateInGroups(ctx, n.holderOf(indexName), entry, release, updates, outcome)
	if err != nil {
		return outcome.result, err
	}
	notifications = n.afterWriteOn(entry, indexName)
	return outcome.result, nil
}

func isPerDocument(err error) bool {
	_, isEngineError := narsilerr.As(err)
	code := narsilerr.CodeOf(err)
	return isEngineError && code != narsilerr.CodePersistenceSaveFailed && code != narsilerr.CodePersistenceFsyncFailed
}

func (n *Narsil) updateOne(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	update model.DocumentUpdate, touched touchedVectors) (*indexEntry, func(), error) {
	if entry == nil {
		var err error
		if entry, release, err = holder.reacquire(); err != nil {
			return nil, releasedNothing, err
		}
	}
	if err := schema.ValidateDocID(update.DocID); err != nil {
		return entry, release, err
	}
	working := codec.SnapshotDocument(update.Document)
	if err := requireDocument(working); err != nil {
		return entry, release, err
	}
	entry, release, hook, write, err := n.replaceDocument(ctx, entry, release, holder, update.DocID, working)
	if err != nil {
		return entry, release, err
	}
	touched.note(write)
	if !n.plugins.hasHook(hookAfterUpdate) {
		return entry, release, nil
	}
	scheduleTouched(entry, touched)
	release()
	_ = n.plugins.update(ctx, hookAfterUpdate, hook)
	return nil, releasedNothing, nil
}

// RemoveBatch deletes the documents under docIDs from the index called
// indexName and reports each one the same way as InsertBatch. An ID that
// holds no document fails with CodeDocNotFound.
func (n *Narsil) RemoveBatch(ctx context.Context, indexName string, docIDs []string, options WriteOptions) (BatchResult, error) {
	ctx = callerctx.Shield(ctx)
	entry, release, err := n.acquireContext(ctx, indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer n.emitWrite(indexName)
	defer func() { release() }()
	outcome := newBatchOutcome()
	err = eachBatchChunk(ctx, docIDs, func(chunk []string) error {
		var chunkErr error
		entry, release, chunkErr = n.removeChunk(ctx, n.holderOf(indexName), entry, release, chunk, outcome)
		return chunkErr
	}, func(from int, err error) {
		for _, id := range docIDs[from:] {
			outcome.fail(id, err)
		}
	})
	if len(outcome.result.Succeeded) > 0 {
		n.memory.memoryReleased()
	}
	return outcome.result, err
}

func (n *Narsil) runBeforeRemoveHooks(ctx context.Context, indexName string, ids []string,
	outcome *batchOutcome) []*model.RemoveContext {
	contexts := make([]*model.RemoveContext, 0, len(ids))
	for _, id := range ids {
		if err := schema.ValidateDocID(id); err != nil {
			outcome.fail(id, err)
			continue
		}
		remove := &model.RemoveContext{IndexName: indexName, DocID: id}
		if err := n.plugins.remove(ctx, hookBeforeRemove, remove); err != nil {
			outcome.fail(id, err)
			continue
		}
		contexts = append(contexts, remove)
	}
	return contexts
}

func (n *Narsil) removeChunk(ctx context.Context, holder indexHolder, entry *indexEntry, release func(), ids []string,
	outcome *batchOutcome) (*indexEntry, func(), error) {
	if entry != nil && n.plugins.hasHook(hookBeforeRemove) {
		release()
		entry, release = nil, releasedNothing
	}
	contexts := n.runBeforeRemoveHooks(ctx, holder.name, ids, outcome)
	if entry == nil {
		var err error
		if entry, release, err = holder.reacquire(); err != nil {
			failRemovals(contexts, outcome, err)
			return nil, releasedNothing, err
		}
	}
	entry, release, removed, err := n.applyRemoveChunk(ctx, entry, release, contexts, outcome)
	if err != nil || len(removed) == 0 || !n.plugins.hasHook(hookAfterRemove) {
		return entry, release, err
	}
	release()
	for _, remove := range removed {
		_ = n.plugins.remove(ctx, hookAfterRemove, remove)
	}
	return nil, releasedNothing, nil
}

func (n *Narsil) applyRemoveChunk(ctx context.Context, entry *indexEntry, release func(),
	contexts []*model.RemoveContext, outcome *batchOutcome) (*indexEntry, func(), []*model.RemoveContext, error) {
	candidates := make([]persist.Write, len(contexts))
	for at, remove := range contexts {
		candidates[at] = persist.Write{DocumentID: remove.DocID}
	}
	var accepted []*model.RemoveContext
	var missing []string
	var failures []error
	checked := false
	entry, release, err := n.applyKeepingTokens(ctx, entry.name, entry, release, index.WriteRemove, candidates,
		func(ctx context.Context, entry *indexEntry) (persist.Commit, error) {
			var commit persist.Commit
			var err error
			if accepted, missing, err = acceptedRemovals(ctx, entry, contexts); err != nil {
				return commit, err
			}
			checked = true
			writes := make([]persist.Write, len(accepted))
			for at, remove := range accepted {
				writes[at] = persist.Write{DocumentID: remove.DocID}
			}
			failures, commit, err = entry.apply(ctx, writes, index.WriteRemove)
			return commit, err
		})
	if !checked && err != nil {
		failRemovals(contexts, outcome, err)
		return entry, release, nil, err
	}
	for _, id := range missing {
		outcome.fail(id, documentNotFound(id))
	}
	if err != nil && (!cancelledBatch(err) || len(failures) != len(accepted)) {
		for _, remove := range accepted {
			outcome.fail(remove.DocID, err)
		}
		return entry, release, nil, err
	}
	removed := make([]*model.RemoveContext, 0, len(accepted))
	for at, remove := range accepted {
		if failures[at] != nil {
			outcome.fail(remove.DocID, failures[at])
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, remove.DocID)
		removed = append(removed, remove)
	}
	return entry, release, removed, err
}

func failRemovals(contexts []*model.RemoveContext, outcome *batchOutcome, err error) {
	for _, remove := range contexts {
		outcome.fail(remove.DocID, err)
	}
}

func acceptedRemovals(ctx context.Context, entry *indexEntry, contexts []*model.RemoveContext) (
	[]*model.RemoveContext, []string, error) {
	candidates := make([]string, len(contexts))
	for at, remove := range contexts {
		candidates[at] = remove.DocID
	}
	present, err := entry.presence(ctx, candidates)
	if err != nil {
		return nil, nil, err
	}
	accepted := make([]*model.RemoveContext, 0, len(contexts))
	var missing []string
	seen := make(map[string]struct{}, len(contexts))
	for at, remove := range contexts {
		if _, repeated := seen[remove.DocID]; repeated || !present[at] {
			missing = append(missing, remove.DocID)
			continue
		}
		seen[remove.DocID] = struct{}{}
		accepted = append(accepted, remove)
	}
	return accepted, missing, nil
}
