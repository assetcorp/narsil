package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (n *Narsil) resolveInsertID(document model.Document, docID string) (string, error) {
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

func (n *Narsil) embedOne(ctx context.Context, entry *indexEntry, working model.Document) error {
	if entry.config.Embedding == nil {
		return nil
	}
	adapter := entry.boundEmbedder()
	if adapter == nil {
		return requireMappedVectors(working, entry.config.Embedding, entry.embeddingName)
	}
	return embedDocument(ctx, working, entry.config.Embedding, adapter)
}

func (n *Narsil) prepareOne(ctx context.Context, entry *indexEntry, working model.Document) (persist.Write, error) {
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
// copies the document before it embeds or normalises it, so the caller's map
// keeps its contents. It returns CodeDocAlreadyExists for an ID in use,
// CodeDocValidationFailed or a schema code for a document that the schema
// refuses, CodePartitionCapacityExceeded for a full index, and an embedding
// code when the embedding adapter fails.
func (n *Narsil) Insert(ctx context.Context, indexName string, document Document, docID string, options InsertOptions) (string, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return "", err
	}
	defer release()
	defer n.emitWrite(indexName)
	id, err := n.resolveInsertID(document, docID)
	if err != nil {
		return "", err
	}
	working := shallowCopy(document)
	insert := &model.InsertContext{IndexName: indexName, DocID: id, Document: working}
	if err := n.plugins.insert(ctx, hookBeforeInsert, insert); err != nil {
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
	err = n.applyInsertLocked(ctx, entry, write)
	entry.writeMu.Unlock()
	if err != nil {
		return "", err
	}
	touched := touchedVectors{}
	touched.note(write)
	entry.scheduleVectorBuilds(touched)
	_ = n.plugins.insert(ctx, hookAfterInsert, insert)
	n.afterWrite(entry)
	return id, nil
}

func (n *Narsil) applyInsertLocked(ctx context.Context, entry *indexEntry, write persist.Write) error {
	if entry.holds(write.DocumentID) {
		return entry.alreadyExists(write.DocumentID)
	}
	if err := entry.capacityError(0); err != nil {
		return err
	}
	failures, err := entry.apply(ctx, []persist.Write{write}, writeInsert)
	if err != nil {
		return err
	}
	return failures[0]
}

// Update replaces the stored document under docID in the index called
// indexName with document. It returns CodeDocNotFound when no document holds
// that ID, CodeDocValidationFailed when the document's own "id" names
// another ID, and the same validation and embedding codes as Insert.
func (n *Narsil) Update(ctx context.Context, indexName string, docID string, document Document, options WriteOptions) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	defer n.emitWrite(indexName)
	if err := schema.ValidateDocID(docID); err != nil {
		return err
	}
	if err := schema.RequireMatchingDocID(docID, document); err != nil {
		return err
	}
	working := shallowCopy(document)
	update := &model.UpdateContext{IndexName: indexName, DocID: docID, NewDocument: working}
	if n.plugins.hasUpdateHooks() {
		previous, found := entry.storedDocument(docID)
		if !found {
			previous = model.Document{}
		}
		update.OldDocument = previous
		if err := n.plugins.update(ctx, hookBeforeUpdate, update); err != nil {
			return err
		}
	}
	write, err := n.prepareOne(ctx, entry, update.NewDocument)
	if err != nil {
		return err
	}
	write.DocumentID = docID
	if err := n.heap.admit(indexName); err != nil {
		return err
	}
	entry.writeMu.Lock()
	err = n.applyUpdateLocked(ctx, entry, write)
	entry.writeMu.Unlock()
	if err != nil {
		return err
	}
	touched := touchedVectors{}
	touched.note(write)
	entry.scheduleVectorBuilds(touched)
	_ = n.plugins.update(ctx, hookAfterUpdate, update)
	n.afterWrite(entry)
	return nil
}

func (n *Narsil) applyUpdateLocked(ctx context.Context, entry *indexEntry, write persist.Write) error {
	if !entry.holds(write.DocumentID) {
		return documentNotFound(write.DocumentID)
	}
	failures, err := entry.apply(ctx, []persist.Write{write}, writeUpdate)
	if err != nil {
		return err
	}
	return failures[0]
}

// Remove deletes the document under docID from the index called indexName.
// It returns CodeDocNotFound when no document holds that ID.
func (n *Narsil) Remove(ctx context.Context, indexName string, docID string, options WriteOptions) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	defer n.emitWrite(indexName)
	if err := schema.ValidateDocID(docID); err != nil {
		return err
	}
	remove := &model.RemoveContext{IndexName: indexName, DocID: docID}
	if err := n.plugins.remove(ctx, hookBeforeRemove, remove); err != nil {
		return err
	}
	entry.writeMu.Lock()
	err = n.applyRemoveLocked(ctx, entry, docID)
	entry.writeMu.Unlock()
	if err != nil {
		return err
	}
	_ = n.plugins.remove(ctx, hookAfterRemove, remove)
	return nil
}

func (n *Narsil) applyRemoveLocked(ctx context.Context, entry *indexEntry, docID string) error {
	if !entry.holds(docID) {
		return documentNotFound(docID)
	}
	failures, err := entry.apply(ctx, []persist.Write{{DocumentID: docID}}, writeRemove)
	if err != nil {
		return err
	}
	return failures[0]
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
