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

type pendingInsert struct {
	id      string
	context *model.InsertContext
	write   persist.Write
}

func requireDocument(document *model.Document) error {
	if document == nil {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Each document must be an object, while this entry is null",
			map[string]any{"received": "null"})
	}
	return nil
}

// InsertBatch adds documents to the index called indexName in chunks of
// 1,000 and reports each one: the IDs that the engine wrote, and each
// refused document with its error. One refused document never stops the
// rest, and a nil entry is refused with CodeDocValidationFailed. The engine
// reads each document once, as Insert does. The returned error is set only
// when the whole call fails, such as for an unknown index, a cancelled
// context, or a durable write that failed.
func (n *Narsil) InsertBatch(ctx context.Context, indexName string, documents []*Document, options InsertOptions) (BatchResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer release()
	defer n.emitWrite(indexName)
	outcome := newBatchOutcome()
	defer entry.scheduleVectorBuilds(outcome.touched)
	err = eachBatchChunk(ctx, documents, func(chunk []*model.Document) error {
		return n.insertChunk(ctx, entry, chunk, outcome)
	})
	if err != nil {
		return outcome.result, err
	}
	n.afterWrite(entry)
	return outcome.result, nil
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

func (n *Narsil) insertChunk(ctx context.Context, entry *indexEntry, documents []*model.Document, outcome *batchOutcome) error {
	contexts := make([]*model.InsertContext, len(documents))
	working := make([]*model.Document, len(documents))
	live := make([]bool, len(documents))
	for at := range documents {
		document := codec.SnapshotDocument(documents[at])
		reported, _ := schema.ProvidedDocID(document)
		if err := requireDocument(document); err != nil {
			outcome.fail(reported, err)
			continue
		}
		id, err := n.resolveInsertID(document, "")
		if err != nil {
			outcome.fail(reported, err)
			continue
		}
		contexts[at] = &model.InsertContext{IndexName: entry.name, DocID: id, Document: document}
		if err := n.plugins.insert(ctx, hookBeforeInsert, contexts[at]); err != nil {
			outcome.fail(id, err)
			continue
		}
		working[at] = contexts[at].Document
		if err := requireDocument(working[at]); err != nil {
			outcome.fail(id, err)
			continue
		}
		if len(entry.config.Required) > 0 {
			if err := schema.ValidateRequiredFields(working[at], entry.config.Required); err != nil {
				outcome.fail(id, err)
				continue
			}
		}
		live[at] = true
	}
	if err := n.embedChunk(ctx, entry, working, live, contexts, outcome); err != nil {
		return err
	}
	pending := make([]pendingInsert, 0, len(documents))
	for at := range documents {
		if !live[at] {
			continue
		}
		write, err := entry.prepared(working[at])
		if err != nil {
			outcome.fail(contexts[at].DocID, err)
			continue
		}
		write.DocumentID = contexts[at].DocID
		pending = append(pending, pendingInsert{id: write.DocumentID, context: contexts[at], write: write})
	}
	if err := n.heap.admit(entry.name); err != nil {
		for _, insert := range pending {
			outcome.fail(insert.id, err)
		}
		return nil
	}
	return n.applyInsertChunk(ctx, entry, pending, outcome)
}

func (n *Narsil) embedChunk(ctx context.Context, entry *indexEntry, working []*model.Document, live []bool,
	contexts []*model.InsertContext, outcome *batchOutcome) error {
	config := entry.config.Embedding
	if config == nil {
		return nil
	}
	adapter := entry.boundEmbedder()
	if adapter == nil {
		for at := range working {
			if !live[at] {
				continue
			}
			if err := requireMappedVectors(working[at], config, entry.embeddingName); err != nil {
				live[at] = false
				outcome.fail(contexts[at].DocID, err)
			}
		}
		return nil
	}
	failed, err := embedBatch(ctx, working, live, config, adapter)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		for at := range working {
			if live[at] {
				live[at] = false
				outcome.fail(contexts[at].DocID, err)
			}
		}
		return nil
	}
	for at := range working {
		if failure, refused := failed[at]; refused && live[at] {
			live[at] = false
			outcome.fail(contexts[at].DocID, failure)
		}
	}
	return nil
}

func (n *Narsil) applyInsertChunk(ctx context.Context, entry *indexEntry, pending []pendingInsert, outcome *batchOutcome) error {
	entry.writeMu.Lock()
	ids := make([]string, len(pending))
	for at, insert := range pending {
		ids[at] = insert.id
	}
	present, err := entry.presence(ctx, ids)
	if err != nil {
		entry.writeMu.Unlock()
		return err
	}
	accepted := make([]pendingInsert, 0, len(pending))
	seen := make(map[string]struct{}, len(pending))
	for at, insert := range pending {
		if _, repeated := seen[insert.id]; repeated || present[at] {
			outcome.fail(insert.id, entry.alreadyExists(insert.id))
			continue
		}
		if err := entry.capacityError(len(accepted)); err != nil {
			outcome.fail(insert.id, err)
			continue
		}
		seen[insert.id] = struct{}{}
		accepted = append(accepted, insert)
	}
	writes := make([]persist.Write, len(accepted))
	for at, insert := range accepted {
		writes[at] = insert.write
	}
	failures, err := entry.apply(ctx, writes, index.WriteInsert)
	entry.writeMu.Unlock()
	if err != nil {
		for _, insert := range accepted {
			outcome.fail(insert.id, err)
		}
		return err
	}
	for at, insert := range accepted {
		if failures[at] != nil {
			outcome.fail(insert.id, failures[at])
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, insert.id)
		outcome.touched.note(insert.write)
		_ = n.plugins.insert(ctx, hookAfterInsert, insert.context)
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
	defer release()
	defer n.emitWrite(indexName)
	outcome := newBatchOutcome()
	defer entry.scheduleVectorBuilds(outcome.touched)
	for _, update := range updates {
		if err := ctx.Err(); err != nil {
			return outcome.result, err
		}
		if err := n.updateOne(ctx, entry, update, outcome.touched); err != nil {
			if !isPerDocument(err) {
				return outcome.result, err
			}
			outcome.fail(update.DocID, err)
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, update.DocID)
	}
	n.afterWrite(entry)
	return outcome.result, nil
}

func isPerDocument(err error) bool {
	_, isEngineError := narsilerr.As(err)
	return isEngineError && narsilerr.CodeOf(err) != narsilerr.CodePersistenceSaveFailed
}

func (n *Narsil) updateOne(ctx context.Context, entry *indexEntry, update model.DocumentUpdate, touched touchedVectors) error {
	if err := schema.ValidateDocID(update.DocID); err != nil {
		return err
	}
	working := codec.SnapshotDocument(update.Document)
	if err := requireDocument(working); err != nil {
		return err
	}
	hook, write, err := n.replaceDocument(ctx, entry, entry.name, update.DocID, working)
	if err != nil {
		return err
	}
	touched.note(write)
	_ = n.plugins.update(ctx, hookAfterUpdate, hook)
	return nil
}

// RemoveBatch deletes the documents under docIDs from the index called
// indexName and reports each one the same way as InsertBatch. An ID that
// holds no document fails with CodeDocNotFound.
func (n *Narsil) RemoveBatch(ctx context.Context, indexName string, docIDs []string, options WriteOptions) (BatchResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.BatchResult{}, err
	}
	defer release()
	defer n.emitWrite(indexName)
	outcome := newBatchOutcome()
	err = eachBatchChunk(ctx, docIDs, func(chunk []string) error {
		return n.removeChunk(ctx, entry, chunk, outcome)
	})
	return outcome.result, err
}

func (n *Narsil) removeChunk(ctx context.Context, entry *indexEntry, ids []string, outcome *batchOutcome) error {
	contexts := make([]*model.RemoveContext, 0, len(ids))
	for _, id := range ids {
		if err := schema.ValidateDocID(id); err != nil {
			outcome.fail(id, err)
			continue
		}
		remove := &model.RemoveContext{IndexName: entry.name, DocID: id}
		if err := n.plugins.remove(ctx, hookBeforeRemove, remove); err != nil {
			outcome.fail(id, err)
			continue
		}
		contexts = append(contexts, remove)
	}
	entry.writeMu.Lock()
	candidates := make([]string, len(contexts))
	for at, remove := range contexts {
		candidates[at] = remove.DocID
	}
	present, err := entry.presence(ctx, candidates)
	if err != nil {
		entry.writeMu.Unlock()
		return err
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
	failures, err := entry.apply(ctx, writes, index.WriteRemove)
	entry.writeMu.Unlock()
	if err != nil {
		for _, remove := range accepted {
			outcome.fail(remove.DocID, err)
		}
		return err
	}
	for at, remove := range accepted {
		if failures[at] != nil {
			outcome.fail(remove.DocID, failures[at])
			continue
		}
		outcome.result.Succeeded = append(outcome.result.Succeeded, remove.DocID)
		_ = n.plugins.remove(ctx, hookAfterRemove, remove)
	}
	return nil
}
