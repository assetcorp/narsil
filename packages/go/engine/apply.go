package engine

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (entry *indexEntry) alreadyExists(id string) error {
	partitionID := entry.index().RoutePartition(id)
	return narsilerr.New(narsilerr.CodeDocAlreadyExists,
		`Document "`+id+`" already exists in partition `+strconv.Itoa(partitionID),
		map[string]any{"docId": id, "partitionId": partitionID})
}

func documentNotFound(id string) error {
	return narsilerr.New(narsilerr.CodeDocNotFound, `Document "`+id+`" not found in any partition`, map[string]any{"docId": id})
}

func (entry *indexEntry) capacityError(pending int) error {
	maximum, capped := entry.currentConfig().Partitions.MaxDocsPerPartition.Get()
	if !capped {
		return nil
	}
	partitions := entry.capacityPartitionCount()
	total := maximum * partitions
	current := entry.index().Count() + pending + entry.queuedWrites()
	if current < total {
		return nil
	}
	return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
		`Index "`+entry.name+`" has reached its capacity of `+strconv.Itoa(total)+` documents (`+strconv.Itoa(maximum)+
			` per partition × `+strconv.Itoa(partitions)+` partitions)`,
		map[string]any{"indexName": entry.name, "currentCount": current, "totalCapacity": total,
			"maxDocsPerPartition": maximum, "partitionCount": partitions})
}

func (entry *indexEntry) prepared(document *model.Document) (persist.Write, error) {
	prepared, err := schema.PrepareDocument(document, entry.parsed, entry.rules())
	if err != nil {
		return persist.Write{}, err
	}
	encoded, err := codec.EncodeDocument(prepared.Document)
	if err != nil {
		return persist.Write{}, err
	}
	return persist.Write{Document: prepared.Document.Map(), Encoded: encoded, Vectors: prepared.Vectors}, nil
}

func (entry *indexEntry) apply(ctx context.Context, writes []persist.Write, kind index.WriteKind) ([]error, error) {
	if len(writes) == 0 {
		return []error{}, nil
	}
	if buffered, intercepted, err := entry.intercept(ctx, writes); intercepted {
		return buffered, err
	}
	var failures []error
	var err error
	if entry.durable != nil {
		failures, err = entry.durable.Apply(ctx, writes)
	} else {
		failures, err = entry.applyInMemory(writes, kind)
	}
	if err != nil {
		return nil, err
	}
	for at, failure := range failures {
		failures[at] = documentTokensRefused(failure)
	}
	return failures, nil
}

type touchedVectors map[string]struct{}

func (touched touchedVectors) note(write persist.Write) {
	for path := range write.Vectors {
		touched[path] = struct{}{}
	}
}

func (entry *indexEntry) scheduleVectorBuilds(touched touchedVectors) {
	for _, path := range entry.vectorPaths {
		if _, held := touched[path]; held {
			entry.handle.Vectors[path].ScheduleBuild()
		}
	}
}

func (entry *indexEntry) applyInMemory(writes []persist.Write, kind index.WriteKind) ([]error, error) {
	return entry.index().Apply(kind, persist.DocumentWrites(writes), entry.handle.NamedVectorFields())
}

func engineErrorOf(err error) *narsilerr.Error {
	if engineError, isEngineError := narsilerr.As(err); isEngineError {
		return engineError
	}
	return narsilerr.New(narsilerr.CodeDocValidationFailed, err.Error(), nil)
}
