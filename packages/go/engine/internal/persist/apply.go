package persist

import (
	"context"
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type Handle struct {
	Name             string
	Index            *index.Index
	Schema           *schema.Parsed
	Vectors          map[string]*vector.Field
	Metadata         func(documentCount uint64) (metadata.Metadata, error)
	NewDetachedIndex func() (*index.Index, error)
	SyncHistoryMoved func()
	removalPages     removalPageCache
}

func (handle *Handle) metadata(documentCount uint64) (metadata.Metadata, error) {
	if handle.Metadata == nil {
		return metadata.Metadata{}, narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+handle.Name+`" has no way to describe its metadata`, map[string]any{"indexName": handle.Name})
	}
	return handle.Metadata(documentCount)
}

type pendingRun struct {
	kind    index.WriteKind
	members []int
	ids     map[string]struct{}
}

func (handle *Handle) vectorPaths() map[string]int {
	if handle.Schema == nil {
		return map[string]int{}
	}
	return handle.Schema.VectorFields()
}

func (handle *Handle) requireDimensions(write Write) error {
	for path, values := range write.Vectors {
		field, known := handle.Vectors[path]
		if !known {
			return narsilerr.New(narsilerr.CodeDocValidationFailed,
				`The document carries a vector for "`+path+`", which the schema does not declare`,
				map[string]any{"field": path})
		}
		if len(values) != field.Dimension() {
			return narsilerr.New(narsilerr.CodeVectorDimensionMismatch,
				`The vector for "`+path+`" holds `+strconv.Itoa(len(values))+" values where the field holds "+
					strconv.Itoa(field.Dimension()), map[string]any{"field": path})
		}
	}
	return nil
}

func (handle *Handle) NamedVectorFields() []vector.NamedField {
	fields := make([]vector.NamedField, 0, len(handle.Vectors))
	for path, field := range handle.Vectors {
		fields = append(fields, vector.NamedField{Path: path, Field: field})
	}
	sort.Slice(fields, func(left, right int) bool { return fields[left].Path < fields[right].Path })
	return fields
}

func DocumentWrites(writes []Write) []index.DocumentWrite {
	documents := make([]index.DocumentWrite, len(writes))
	for at, write := range writes {
		documents[at] = index.DocumentWrite{ID: write.DocumentID, Fields: write.Document, Encoded: write.Encoded,
			Vectors: write.Vectors}
	}
	return documents
}

func (handle *Handle) flushRun(run *pendingRun, writes []Write, failures []error) error {
	if len(run.members) == 0 {
		return nil
	}
	selected := make([]Write, len(run.members))
	for at, member := range run.members {
		selected[at] = writes[member]
	}
	refused, err := handle.Index.Apply(run.kind, DocumentWrites(selected), handle.NamedVectorFields())
	for at, member := range run.members {
		if at < len(refused) && refused[at] != nil {
			failures[member] = refused[at]
		}
	}
	run.members = run.members[:0]
	clear(run.ids)
	return err
}

func (handle *Handle) kindOf(ctx context.Context, write Write) (index.WriteKind, error) {
	if write.deletes() {
		return index.WriteRemove, nil
	}
	held, err := handle.Index.Has(ctx, write.DocumentID)
	if err != nil || !held {
		return index.WriteInsert, err
	}
	return index.WriteUpdate, nil
}

func (handle *Handle) apply(ctx context.Context, writes []Write) ([]error, error) {
	failures := make([]error, len(writes))
	run := &pendingRun{ids: map[string]struct{}{}}
	for at, write := range writes {
		if err := handle.requireDimensions(write); err != nil && !write.deletes() {
			failures[at] = err
			continue
		}
		_, repeated := run.ids[write.DocumentID]
		kind := index.WriteRemove
		if !write.deletes() {
			kind = index.WriteInsert
		}
		if !repeated && kind == index.WriteInsert {
			var err error
			if kind, err = handle.kindOf(ctx, write); err != nil {
				return nil, err
			}
		}
		if repeated || (len(run.members) > 0 && run.kind != kind) {
			if err := handle.flushRun(run, writes, failures); err != nil {
				return nil, err
			}
			var err error
			if kind, err = handle.kindOf(ctx, write); err != nil {
				return nil, err
			}
		}
		run.kind = kind
		run.members = append(run.members, at)
		run.ids[write.DocumentID] = struct{}{}
	}
	if err := handle.flushRun(run, writes, failures); err != nil {
		return nil, err
	}
	return failures, nil
}
