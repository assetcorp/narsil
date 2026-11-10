package engine

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type writeKind uint8

const (
	writeInsert writeKind = iota
	writeUpdate
	writeRemove
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

func (entry *indexEntry) prepared(document model.Document) (persist.Write, error) {
	prepared, err := schema.PrepareDocument(document, entry.parsed, entry.rules())
	if err != nil {
		return persist.Write{}, err
	}
	return persist.Write{Document: prepared.Document, Vectors: prepared.Vectors}, nil
}

func (entry *indexEntry) apply(ctx context.Context, writes []persist.Write, kind writeKind) ([]error, error) {
	if len(writes) == 0 {
		return []error{}, nil
	}
	if buffered, intercepted, err := entry.intercept(ctx, writes); intercepted {
		return buffered, err
	}
	var failures []error
	if entry.durable != nil {
		outcomes, err := entry.durable.Apply(ctx, writes)
		if err != nil {
			return nil, err
		}
		failures = outcomes
	} else {
		failures = entry.applyInMemory(writes, kind)
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

func (entry *indexEntry) applyInMemory(writes []persist.Write, kind writeKind) []error {
	ix := entry.index()
	var failures []error
	switch kind {
	case writeRemove:
		ids := make([]string, len(writes))
		for at, write := range writes {
			ids[at] = write.DocumentID
		}
		failures = ix.Remove(ids)
	default:
		documents := make([]partition.Document, len(writes))
		for at, write := range writes {
			documents[at] = partition.Document{ID: write.DocumentID, Fields: write.Document}
		}
		if kind == writeInsert {
			failures = ix.Insert(documents)
		} else {
			failures = ix.Update(documents)
		}
	}
	if len(entry.vectorPaths) == 0 {
		return failures
	}
	indexed := append([]error(nil), failures...)
	documents := make([]vector.DocumentVectors, len(writes))
	for at, write := range writes {
		documents[at] = vector.DocumentVectors{DocID: write.DocumentID, Vectors: write.Vectors,
			Partition: int32(ix.RoutePartition(write.DocumentID)), Remove: kind == writeRemove}
	}
	fields := entry.namedVectorFields()
	vector.ApplyDocuments(fields, documents, failures)
	if kind != writeInsert {
		return failures
	}
	var refused []string
	for at, write := range writes {
		if indexed[at] == nil && failures[at] != nil {
			refused = append(refused, write.DocumentID)
		}
	}
	if len(refused) > 0 {
		_ = ix.Remove(refused)
		vector.RemoveDocuments(fields, refused)
	}
	return failures
}

func (entry *indexEntry) namedVectorFields() []vector.NamedField {
	fields := make([]vector.NamedField, len(entry.vectorPaths))
	for at, path := range entry.vectorPaths {
		fields[at] = vector.NamedField{Path: path, Field: entry.handle.Vectors[path]}
	}
	return fields
}

func engineErrorOf(err error) *narsilerr.Error {
	if engineError, isEngineError := narsilerr.As(err); isEngineError {
		return engineError
	}
	return narsilerr.New(narsilerr.CodeDocValidationFailed, err.Error(), nil)
}
