package index

import (
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	missingReducerMessage      = "group.reduce.reducer is not a function"
	missingInitialValueMessage = "group.reduce.initialValue is not a function"
)

type hitGroup struct {
	values       map[string]any
	hits         []resultHit
	reduced      model.Optional[any]
	reducerError model.Optional[string]
}

type reducerRow struct {
	document *model.Document
	found    bool
	score    float64
}

func reducerFailureMessage(failure any) string {
	if typed, isNarsil := failure.(*narsilerr.Error); isNarsil && typed != nil {
		return typed.Message
	}
	if typed, isError := failure.(error); isError && typed != nil {
		return typed.Error()
	}
	return fmt.Sprint(failure)
}

func foldGroupReducer(reduce model.GroupReducer, rows []reducerRow) (reduced any, failure model.Optional[string]) {
	defer func() {
		if recovered := recover(); recovered != nil {
			reduced, failure = nil, model.Some(reducerFailureMessage(recovered))
		}
	}()
	if reduce.InitialValue == nil {
		return nil, model.Some(missingInitialValueMessage)
	}
	accumulator := reduce.InitialValue()
	for _, row := range rows {
		if !row.found {
			continue
		}
		if reduce.Reduce == nil {
			return nil, model.Some(missingReducerMessage)
		}
		next, err := reduce.Reduce(accumulator, row.document, row.score)
		if err != nil {
			return nil, model.Some(reducerFailureMessage(err))
		}
		accumulator = next
	}
	return accumulator, model.Optional[string]{}
}

func absentStoredRef() query.StoredRef {
	return query.StoredRef{Values: &core.StoredValueSlices{Shapes: []uint8{0}, Starts: []uint32{0, 0}}}
}

func (ix *Index) groupedHitsOf(prepared *preparedQuery, hits []resultHit, fields []string) ([]query.GroupedHit, error) {
	views, err := prepared.reads.views.all()
	if err != nil {
		return nil, err
	}
	snapshots := prepared.reads.reading.Snapshots
	absent := absentStoredRef()
	grouped := make([]query.GroupedHit, len(hits))
	for at, hit := range hits {
		partition := ix.partitionOf(hit.ID)
		segment, ordinal, found, err := snapshots[partition].Locate(hit.ID)
		if err != nil {
			return nil, err
		}
		refs := make([]query.StoredRef, len(fields))
		for slot, field := range fields {
			refs[slot] = absent
			if !found || segment >= len(views[partition].Segments) {
				continue
			}
			if values := views[partition].Segments[segment].Fields.Stored[field]; values != nil {
				refs[slot] = query.StoredRef{Values: values, Ordinal: ordinal}
			}
		}
		grouped[at] = query.GroupedHit{ID: hit.ID, Score: scoreOrZero(hit), Fields: refs}
	}
	return grouped, nil
}

func groupValuesOf(document *codec.Document, fields []string) map[string]any {
	values := make(map[string]any, len(fields))
	for _, field := range fields {
		if value, present := partition.NestedValue(document, field); present {
			values[field] = codec.SnapshotValue(value)
		} else {
			values[field] = nil
		}
	}
	return values
}

func pickHits(hits []resultHit, positions []int) []resultHit {
	picked := make([]resultHit, len(positions))
	for at, position := range positions {
		picked[at] = hits[position]
	}
	return picked
}

func (ix *Index) applyGrouping(prepared *preparedQuery, hits []resultHit, config model.GroupConfig, documents *documentLookup) ([]hitGroup, error) {
	if len(config.Fields) == 0 {
		return []hitGroup{{values: map[string]any{}, hits: hits}}, nil
	}
	if len(hits) == 0 {
		return []hitGroup{}, nil
	}
	grouped, err := ix.groupedHitsOf(prepared, hits, config.Fields)
	if err != nil {
		return nil, err
	}
	found, err := query.GroupHits(grouped, config)
	if err != nil {
		return nil, err
	}
	groups := make([]hitGroup, len(found))
	for at, entry := range found {
		group := hitGroup{values: groupValuesOf(documents.withFields(hits[entry.Head].ID, config.Fields), config.Fields), hits: pickHits(hits, entry.Hits)}
		if config.Reduce != nil {
			rows := make([]reducerRow, len(entry.Every))
			for row, position := range entry.Every {
				document := documents.shownAs(hits[position].ID, projection.Whole())
				rows[row] = reducerRow{document: document, found: document != nil, score: scoreOrZero(hits[position])}
			}
			reduced, failure := foldGroupReducer(*config.Reduce, rows)
			if failure.IsSet() {
				group.reducerError = failure
			} else {
				group.reduced = model.Some(reduced)
			}
		}
		groups[at] = group
	}
	return groups, documents.failure()
}
