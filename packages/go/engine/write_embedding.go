package engine

import (
	"context"
	"fmt"
	"reflect"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func releasedNothing() {}

func lacksVectors(document *model.Document, config *model.EmbeddingFieldConfig) bool {
	for target := range config.Fields {
		if resolvePath(document, target) == nil {
			return true
		}
	}
	return false
}

func writeAdapterKeptChanging(indexName string, embeddings int) error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		fmt.Sprintf("Changes to index %q replaced its embedding adapter after each of %d embeddings of this write", indexName, embeddings),
		map[string]any{"indexName": indexName, "embeddings": embeddings})
}

func (bound boundAdapter) embedsFor(entry *indexEntry, config *model.EmbeddingFieldConfig) bool {
	current := entry.config.Embedding
	if current == nil || !bound.fits(entry) {
		return false
	}
	return entry == bound.entry || reflect.DeepEqual(config.Fields, current.Fields)
}

func requireFieldsOf(entry *indexEntry, document *model.Document) error {
	if err := schema.RequireDocument(document); err != nil {
		return err
	}
	if len(entry.config.Required) == 0 {
		return nil
	}
	return schema.ValidateRequiredFields(document, entry.config.Required)
}

func (n *Narsil) embedForWrite(ctx context.Context, indexName string, entry *indexEntry, release func(),
	working *model.Document) (*indexEntry, func(), *model.Document, error) {
	for embeddings := 0; ; embeddings++ {
		config := entry.config.Embedding
		adapter, binding := entry.boundEmbedderWithBinding()
		if config == nil || adapter == nil || !lacksVectors(working, config) {
			return entry, release, working, nil
		}
		if err := requireFieldsOf(entry, working); err != nil {
			return entry, release, working, nil
		}
		if embeddings >= maxCallsAcrossIndexChanges {
			return entry, release, working, writeAdapterKeptChanging(indexName, embeddings)
		}
		embedded := codec.SnapshotDocument(working)
		used := boundAdapter{adapter: adapter, entry: entry, binding: binding}
		release()
		embedErr := embedDocument(ctx, embedded, config, adapter)
		var err error
		if entry, release, err = n.acquire(indexName); err != nil {
			return nil, releasedNothing, nil, err
		}
		if embedErr != nil {
			return entry, release, working, embedErr
		}
		if used.embedsFor(entry, config) {
			return entry, release, embedded, nil
		}
	}
}

type chunkEmbedding struct {
	working  []*model.Document
	live     []bool
	contexts []*model.InsertContext
	outcome  *batchOutcome
}

func (chunk chunkEmbedding) failLive(err error) {
	for at := range chunk.working {
		if chunk.live[at] {
			chunk.live[at] = false
			chunk.outcome.fail(chunk.contexts[at].DocID, err)
		}
	}
}

func (chunk chunkEmbedding) lacksVectors(config *model.EmbeddingFieldConfig) bool {
	for at, document := range chunk.working {
		if chunk.live[at] && lacksVectors(document, config) {
			return true
		}
	}
	return false
}

func (chunk chunkEmbedding) requireMappedVectors(entry *indexEntry, config *model.EmbeddingFieldConfig) {
	for at := range chunk.working {
		if !chunk.live[at] {
			continue
		}
		if err := requireMappedVectors(chunk.working[at], config, entry.embeddingName); err != nil {
			chunk.live[at] = false
			chunk.outcome.fail(chunk.contexts[at].DocID, err)
		}
	}
}

func (chunk chunkEmbedding) requireFieldsOf(entry *indexEntry) {
	for at := range chunk.working {
		if !chunk.live[at] {
			continue
		}
		if err := requireFieldsOf(entry, chunk.working[at]); err != nil {
			chunk.live[at] = false
			chunk.outcome.fail(chunk.contexts[at].DocID, err)
		}
	}
}

func (chunk chunkEmbedding) snapshots() []*model.Document {
	embedded := make([]*model.Document, len(chunk.working))
	for at, document := range chunk.working {
		if chunk.live[at] {
			embedded[at] = codec.SnapshotDocument(document)
		}
	}
	return embedded
}

func (chunk chunkEmbedding) adopt(embedded []*model.Document, failed map[int]error) {
	for at := range chunk.working {
		if !chunk.live[at] {
			continue
		}
		if failure, refused := failed[at]; refused {
			chunk.live[at] = false
			chunk.outcome.fail(chunk.contexts[at].DocID, failure)
			continue
		}
		chunk.working[at] = embedded[at]
		chunk.contexts[at].Document = embedded[at]
	}
}

func (n *Narsil) embedChunk(ctx context.Context, entry *indexEntry, release func(),
	chunk chunkEmbedding) (*indexEntry, func(), error) {
	first := entry
	defer func() {
		if entry != nil && entry != first {
			chunk.requireFieldsOf(entry)
		}
	}()
	for embeddings := 0; ; embeddings++ {
		config := entry.config.Embedding
		if config == nil {
			return entry, release, nil
		}
		adapter, binding := entry.boundEmbedderWithBinding()
		if adapter == nil {
			chunk.requireMappedVectors(entry, config)
			return entry, release, nil
		}
		if !chunk.lacksVectors(config) {
			return entry, release, nil
		}
		if embeddings >= maxCallsAcrossIndexChanges {
			chunk.failLive(writeAdapterKeptChanging(entry.name, embeddings))
			return entry, release, nil
		}
		embedded := chunk.snapshots()
		used := boundAdapter{adapter: adapter, entry: entry, binding: binding}
		indexName := entry.name
		release()
		failed, embedErr := embedBatch(ctx, embedded, chunk.live, config, adapter)
		if embedErr != nil && ctx.Err() != nil {
			entry = nil
			return nil, releasedNothing, ctx.Err()
		}
		var err error
		if entry, release, err = n.acquire(indexName); err != nil {
			entry = nil
			return nil, releasedNothing, err
		}
		if embedErr != nil {
			chunk.failLive(embedErr)
			return entry, release, nil
		}
		if used.embedsFor(entry, config) {
			chunk.adopt(embedded, failed)
			return entry, release, nil
		}
	}
}
