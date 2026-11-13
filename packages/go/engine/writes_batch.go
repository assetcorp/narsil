package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type batchOutcome struct {
	result  model.BatchResult
	touched touchedVectors
}

func newBatchOutcome() *batchOutcome {
	return &batchOutcome{result: model.BatchResult{Succeeded: []string{}, Failed: []model.BatchFailure{}},
		touched: touchedVectors{}}
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

func eachBatchChunk[T any](ctx context.Context, entries []T, apply func(chunk []T) error) error {
	for start := 0; start < len(entries); start += batchChunkSize {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := apply(entries[start:min(start+batchChunkSize, len(entries))]); err != nil {
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
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer func() { release() }()
	defer n.emitWrite(indexName)
	outcome := newBatchOutcome()
	defer func() {
		if entry != nil {
			entry.scheduleVectorBuilds(outcome.touched)
		}
	}()
	for _, update := range updates {
		if err := ctx.Err(); err != nil {
			return outcome.result, err
		}
		entry, release, err = n.updateOne(ctx, n.holderOf(indexName), entry, release, update, outcome.touched)
		if err != nil {
			if entry == nil || !isPerDocument(err) {
				return outcome.result, err
			}
			outcome.fail(update.DocID, err)
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, update.DocID)
	}
	n.afterWriteOn(entry, indexName)
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
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer func() { release() }()
	defer n.emitWrite(indexName)
	outcome := newBatchOutcome()
	err = eachBatchChunk(ctx, docIDs, func(chunk []string) error {
		var chunkErr error
		entry, release, chunkErr = n.removeChunk(ctx, n.holderOf(indexName), entry, release, chunk, outcome)
		return chunkErr
	})
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
			return nil, releasedNothing, err
		}
	}
	removed, err := n.applyRemoveChunk(ctx, entry, contexts, outcome)
	if err != nil || len(removed) == 0 || !n.plugins.hasHook(hookAfterRemove) {
		return entry, release, err
	}
	release()
	for _, remove := range removed {
		_ = n.plugins.remove(ctx, hookAfterRemove, remove)
	}
	return nil, releasedNothing, nil
}

func (n *Narsil) applyRemoveChunk(ctx context.Context, entry *indexEntry, contexts []*model.RemoveContext,
	outcome *batchOutcome) ([]*model.RemoveContext, error) {
	entry.writeMu.Lock()
	candidates := make([]string, len(contexts))
	for at, remove := range contexts {
		candidates[at] = remove.DocID
	}
	present, err := entry.presence(ctx, candidates)
	if err != nil {
		entry.writeMu.Unlock()
		return nil, err
	}
	accepted := make([]*model.RemoveContext, 0, len(contexts))
	seen := make(map[string]struct{}, len(contexts))
	for at, remove := range contexts {
		if _, repeated := seen[remove.DocID]; repeated || !present[at] {
			outcome.fail(remove.DocID, documentNotFound(remove.DocID))
			continue
		}
		seen[remove.DocID] = struct{}{}
		accepted = append(accepted, remove)
	}
	writes := make([]persist.Write, len(accepted))
	for at, remove := range accepted {
		writes[at] = persist.Write{DocumentID: remove.DocID}
	}
	failures, commit, err := entry.apply(ctx, writes, index.WriteRemove)
	if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
		err = awaited
	}
	if err != nil {
		for _, remove := range accepted {
			outcome.fail(remove.DocID, err)
		}
		return nil, err
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
	return removed, nil
}
