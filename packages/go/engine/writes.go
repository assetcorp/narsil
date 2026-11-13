package engine

import (
	"cmp"
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (n *Narsil) resolveInsertID(document *model.Document, docID string) (string, error) {
	if docID != "" {
		if err := schema.RequireMatchingDocID(docID, document); err != nil {
			return "", err
		}
		return docID, schema.ValidateDocID(docID)
	}
	if provided, found := schema.ProvidedDocID(document); found {
		return provided, schema.ValidateDocID(provided)
	}
	generated := n.idGenerator()
	return generated, schema.ValidateDocID(generated)
}

func (n *Narsil) embedOne(ctx context.Context, entry *indexEntry, working *model.Document) error {
	if entry.config.Embedding == nil {
		return nil
	}
	adapter := entry.boundEmbedder()
	if adapter == nil {
		return requireMappedVectors(working, entry.config.Embedding, entry.embeddingName)
	}
	return embedDocument(ctx, working, entry.config.Embedding, adapter)
}

func (n *Narsil) prepareOne(ctx context.Context, entry *indexEntry, working *model.Document) (persist.Write, error) {
	if err := schema.RequireDocument(working); err != nil {
		return persist.Write{}, err
	}
	if len(entry.config.Required) > 0 {
		if err := schema.ValidateRequiredFields(working, entry.config.Required); err != nil {
			return persist.Write{}, err
		}
	}
	if err := n.embedOne(ctx, entry, working); err != nil {
		return persist.Write{}, err
	}
	return entry.prepared(working)
}

// Insert adds document to the index called indexName and returns its ID.
// The ID is docID when it is not empty, the document's own "id" string
// otherwise, and a generated UUID version 7 when neither is set. The engine
// reads the document once, before it embeds or normalises its own copy, so
// the caller's document keeps its contents and a later Set on it changes
// nothing that the engine stored. A plugin receives that copy and may change
// it, and a key that a plugin adds is stored after the others. It returns
// CodeDocAlreadyExists for an ID in use, CodeDocValidationFailed or a schema
// code for a nil document or one that the schema refuses,
// CodePartitionCapacityExceeded for a full index, and an embedding code when
// the embedding adapter fails.
//
// The engine calls the embedding adapter while it holds no lock on the index,
// so the adapter can query or restore that index. When a restore replaces the
// index during the call, the document goes whole to the restored index, and
// the engine embeds it again first when the restored index has another
// adapter. The write returns CodeWorkerBusy once restores have changed the
// adapter after each of three embeddings. Update, InsertBatch, and
// UpdateBatch embed the same way, and InsertBatch writes each chunk of 1,000
// documents whole to one index.
func (n *Narsil) Insert(ctx context.Context, indexName string, document *Document, docID string, options InsertOptions) (string, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return "", err
	}
	defer func() { release() }()
	defer n.emitWrite(indexName)
	working := codec.SnapshotDocument(document)
	if err := schema.RequireDocument(working); err != nil {
		return "", err
	}
	id, err := n.resolveInsertID(working, docID)
	if err != nil {
		return "", err
	}
	insert := &model.InsertContext{IndexName: indexName, DocID: id, Document: working}
	if n.plugins.hasHook(hookBeforeInsert) {
		entry, release, err = n.holderOf(indexName).outside(release, func() error {
			return n.plugins.insert(ctx, hookBeforeInsert, insert)
		})
		if err != nil {
			return "", err
		}
	}
	entry, release, insert.Document, err = n.embedForWrite(ctx, indexName, entry, release, insert.Document)
	if err != nil {
		return "", err
	}
	write, err := n.prepareOne(ctx, entry, insert.Document)
	if err != nil {
		return "", err
	}
	write.DocumentID = id
	if err := n.heap.admit(indexName); err != nil {
		return "", err
	}
	entry.writeMu.Lock()
	commit, err := n.applyInsertLocked(ctx, entry, write)
	if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
		err = awaited
	}
	if err != nil {
		return "", err
	}
	touched := touchedVectors{}
	touched.note(write)
	entry.scheduleVectorBuilds(touched)
	if n.plugins.hasHook(hookAfterInsert) {
		release()
		release = releasedNothing
		_ = n.plugins.insert(ctx, hookAfterInsert, insert)
		entry = nil
	}
	n.afterWriteOn(entry, indexName)
	return id, nil
}

func (n *Narsil) applyInsertLocked(ctx context.Context, entry *indexEntry, write persist.Write) (persist.Commit,
	error) {
	if held, err := entry.holds(ctx, write.DocumentID); err != nil || held {
		return persist.Commit{}, cmp.Or(err, entry.alreadyExists(write.DocumentID))
	}
	if err := entry.capacityError(0); err != nil {
		return persist.Commit{}, err
	}
	failures, commit, err := entry.apply(ctx, []persist.Write{write}, index.WriteInsert)
	if err != nil {
		return persist.Commit{}, err
	}
	return commit, failures[0]
}

// Update replaces the stored document under docID in the index called
// indexName with document, which it reads once as Insert does. A value that
// came from Get and that the caller left alone keeps its stored bytes. It
// returns CodeDocNotFound when no document holds that ID,
// CodeDocValidationFailed when the document's own "id" names another ID, and
// the same validation and embedding codes as Insert.
func (n *Narsil) Update(ctx context.Context, indexName string, docID string, document *Document, options WriteOptions) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer func() { release() }()
	defer n.emitWrite(indexName)
	if err := schema.ValidateDocID(docID); err != nil {
		return err
	}
	working := codec.SnapshotDocument(document)
	if err := schema.RequireDocument(working); err != nil {
		return err
	}
	var update *model.UpdateContext
	var write persist.Write
	entry, release, update, write, err = n.replaceDocument(ctx, entry, release, n.holderOf(indexName), docID, working)
	if err != nil {
		return err
	}
	touched := touchedVectors{}
	touched.note(write)
	entry.scheduleVectorBuilds(touched)
	if n.plugins.hasHook(hookAfterUpdate) {
		release()
		release = releasedNothing
		_ = n.plugins.update(ctx, hookAfterUpdate, update)
		entry = nil
	}
	n.afterWriteOn(entry, indexName)
	return nil
}

func (n *Narsil) replaceDocument(ctx context.Context, entry *indexEntry, release func(), holder indexHolder, docID string,
	working *model.Document) (*indexEntry, func(), *model.UpdateContext, persist.Write, error) {
	indexName := holder.name
	if err := schema.RequireMatchingDocID(docID, working); err != nil {
		return entry, release, nil, persist.Write{}, err
	}
	update := &model.UpdateContext{IndexName: indexName, DocID: docID, NewDocument: working}
	if n.plugins.hasUpdateHooks() {
		previous, found, err := entry.storedDocument(ctx, docID)
		if err != nil {
			return entry, release, nil, persist.Write{}, err
		}
		if !found {
			previous = model.NewDocument()
		}
		update.OldDocument = previous
		if n.plugins.hasHook(hookBeforeUpdate) {
			entry, release, err = holder.outside(release, func() error {
				return n.plugins.update(ctx, hookBeforeUpdate, update)
			})
			if err != nil {
				return entry, release, nil, persist.Write{}, err
			}
		}
	}
	entry, release, embedded, err := n.embedForWrite(ctx, indexName, entry, release, update.NewDocument)
	if err != nil {
		return entry, release, nil, persist.Write{}, err
	}
	update.NewDocument = embedded
	write, err := n.prepareOne(ctx, entry, update.NewDocument)
	if err != nil {
		return entry, release, nil, persist.Write{}, err
	}
	write.DocumentID = docID
	if err := n.heap.admit(indexName); err != nil {
		return entry, release, nil, persist.Write{}, err
	}
	entry.writeMu.Lock()
	commit, err := n.applyUpdateLocked(ctx, entry, write)
	if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
		err = awaited
	}
	if err != nil {
		return entry, release, nil, persist.Write{}, err
	}
	return entry, release, update, write, nil
}

func (n *Narsil) applyUpdateLocked(ctx context.Context, entry *indexEntry, write persist.Write) (persist.Commit,
	error) {
	if held, err := entry.holds(ctx, write.DocumentID); err != nil || !held {
		return persist.Commit{}, cmp.Or(err, documentNotFound(write.DocumentID))
	}
	failures, commit, err := entry.apply(ctx, []persist.Write{write}, index.WriteUpdate)
	if err != nil {
		return persist.Commit{}, err
	}
	return commit, failures[0]
}

// Remove deletes the document under docID from the index called indexName.
// It returns CodeDocNotFound when no document holds that ID.
func (n *Narsil) Remove(ctx context.Context, indexName string, docID string, options WriteOptions) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer func() { release() }()
	defer n.emitWrite(indexName)
	if err := schema.ValidateDocID(docID); err != nil {
		return err
	}
	remove := &model.RemoveContext{IndexName: indexName, DocID: docID}
	if n.plugins.hasHook(hookBeforeRemove) {
		entry, release, err = n.holderOf(indexName).outside(release, func() error {
			return n.plugins.remove(ctx, hookBeforeRemove, remove)
		})
		if err != nil {
			return err
		}
	}
	entry.writeMu.Lock()
	commit, err := n.applyRemoveLocked(ctx, entry, docID)
	if awaited := entry.unlockAndAwait(ctx, commit); err == nil {
		err = awaited
	}
	if err != nil {
		return err
	}
	if n.plugins.hasHook(hookAfterRemove) {
		release()
		release = releasedNothing
		_ = n.plugins.remove(ctx, hookAfterRemove, remove)
	}
	return nil
}

func (n *Narsil) applyRemoveLocked(ctx context.Context, entry *indexEntry, docID string) (persist.Commit, error) {
	if held, err := entry.holds(ctx, docID); err != nil || !held {
		return persist.Commit{}, cmp.Or(err, documentNotFound(docID))
	}
	failures, commit, err := entry.apply(ctx, []persist.Write{{DocumentID: docID}}, index.WriteRemove)
	if err != nil {
		return persist.Commit{}, err
	}
	return commit, failures[0]
}

// WaitForWrites returns once every write that the index called indexName
// acknowledged is visible to queries. The engine applies a write before it
// acknowledges it, except during a rebalance, which queues writes until the
// new partitions answer, so the call waits for that queue alone.
func (n *Narsil) WaitForWrites(ctx context.Context, indexName string) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	return entry.awaitReplay(ctx)
}

func (n *Narsil) afterWrite(entry *indexEntry) {
	n.checkWatermark(entry)
	n.heap.check(entry.name, entry.estimatedBytes)
	n.workers.consider(entry)
}

func (n *Narsil) checkWatermark(entry *indexEntry) {
	partitionConfig := entry.currentConfig().Partitions
	maximum, capped := partitionConfig.MaxDocsPerPartition.Get()
	watermark, marked := partitionConfig.Watermark.Get()
	if !capped || !marked {
		return
	}
	partitions := entry.index().PartitionCount()
	capacity := maximum * partitions
	count := entry.index().Count()
	entry.writeMu.Lock()
	if float64(count) < watermark*float64(capacity) {
		entry.watermarkLatched = 0
		entry.writeMu.Unlock()
		return
	}
	if entry.watermarkLatched == capacity {
		entry.writeMu.Unlock()
		return
	}
	entry.watermarkLatched = capacity
	entry.writeMu.Unlock()
	n.events.emit(model.PartitionWatermarkEvent{IndexName: entry.name, DocumentCount: count, Capacity: capacity,
		PartitionCount: partitions})
}
