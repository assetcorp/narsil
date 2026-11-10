package persist

import (
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
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
}

func (handle *Handle) metadata(documentCount uint64) (metadata.Metadata, error) {
	if handle.Metadata == nil {
		return metadata.Metadata{}, narsilerr.New(narsilerr.CodeConfigInvalid,
			`Index "`+handle.Name+`" has no way to describe its metadata`, map[string]any{"indexName": handle.Name})
	}
	return handle.Metadata(documentCount)
}

type runKind uint8

const (
	runInsert runKind = iota
	runUpdate
	runRemove
)

type pendingRun struct {
	kind    runKind
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

func (handle *Handle) namedVectorFields() []vector.NamedField {
	fields := make([]vector.NamedField, 0, len(handle.Vectors))
	for path, field := range handle.Vectors {
		fields = append(fields, vector.NamedField{Path: path, Field: field})
	}
	sort.Slice(fields, func(left, right int) bool { return fields[left].Path < fields[right].Path })
	return fields
}

func (handle *Handle) applyVectors(writes []Write, partitionID int, failures []error) {
	if len(handle.Vectors) == 0 {
		return
	}
	documents := make([]vector.DocumentVectors, len(writes))
	for at, write := range writes {
		documents[at] = vector.DocumentVectors{DocID: write.DocumentID, Vectors: write.Vectors,
			Partition: int32(partitionID), Remove: write.deletes()}
	}
	vector.ApplyDocuments(handle.namedVectorFields(), documents, failures)
}

func (handle *Handle) flushRun(run *pendingRun, writes []Write, failures []error) {
	if len(run.members) == 0 {
		return
	}
	var errs []error
	switch run.kind {
	case runRemove:
		ids := make([]string, len(run.members))
		for at, member := range run.members {
			ids[at] = writes[member].DocumentID
		}
		errs = handle.Index.Remove(ids)
	default:
		documents := make([]partition.Document, len(run.members))
		for at, member := range run.members {
			documents[at] = partition.Document{ID: writes[member].DocumentID, Fields: writes[member].Document}
		}
		if run.kind == runInsert {
			errs = handle.Index.Insert(documents)
		} else {
			errs = handle.Index.Update(documents)
		}
	}
	for at, member := range run.members {
		if at < len(errs) && errs[at] != nil {
			failures[member] = errs[at]
		}
	}
	run.members = run.members[:0]
	clear(run.ids)
}

func (handle *Handle) apply(writes []Write, partitionID int) []error {
	failures := make([]error, len(writes))
	run := &pendingRun{ids: map[string]struct{}{}}
	for at, write := range writes {
		if err := handle.requireDimensions(write); err != nil && !write.deletes() {
			failures[at] = err
			continue
		}
		_, repeated := run.ids[write.DocumentID]
		kind := runRemove
		if !write.deletes() {
			kind = runInsert
			if !repeated && handle.Index.Has(write.DocumentID) {
				kind = runUpdate
			}
		}
		if repeated || (len(run.members) > 0 && run.kind != kind) {
			handle.flushRun(run, writes, failures)
			if !write.deletes() && handle.Index.Has(write.DocumentID) {
				kind = runUpdate
			}
		}
		run.kind = kind
		run.members = append(run.members, at)
		run.ids[write.DocumentID] = struct{}{}
	}
	handle.flushRun(run, writes, failures)
	handle.applyVectors(writes, partitionID, failures)
	return failures
}
