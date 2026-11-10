package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func schemaTypes(settings Settings) map[string]schema.ParsedFieldType {
	types := make(map[string]schema.ParsedFieldType, len(settings.TextFields)+len(settings.ValueFields))
	for _, group := range [][]schema.Field{settings.TextFields, settings.ValueFields} {
		for _, field := range group {
			types[field.Path] = field.ParsedFieldType
		}
	}
	return types
}

func emptyFieldIndexes() query.FieldIndexes {
	return query.FieldIndexes{
		Numeric: map[string]*core.NumericIndex{},
		Size:    map[string]*core.NumericIndex{},
		Boolean: map[string]*core.BooleanIndex{},
		Enum:    map[string]*core.EnumIndex{},
		Geo:     map[string]*core.GeoIndex{},
		Pattern: map[string]*core.PatternIndex{},
		Stored:  map[string]*core.StoredValueSlices{},
		Sort:    map[query.SortColumnKey]*core.SortColumn{},
		Present: map[string][]uint32{},
	}
}

func addColumns(indexes *query.FieldIndexes, set *fields.Set) {
	for _, path := range set.StoredFields() {
		slices := set.Stored(path).Slices()
		indexes.Stored[path] = &slices
	}
	if columns := set.SortColumns(); columns != nil {
		for _, column := range columns.Columns() {
			indexes.Sort[query.SortColumnKey{Field: column.Field(), Mode: column.Mode()}] = column.Column()
		}
	}
}

func growingIndexes(set *fields.Set, declared []schema.Field) query.FieldIndexes {
	indexes := emptyFieldIndexes()
	for _, field := range declared {
		path := field.Path
		if index := set.Numeric(path); index != nil {
			indexes.Numeric[path] = index.Index()
		}
		if index := set.Sizes(path); index != nil {
			indexes.Size[path] = index.Index()
		}
		if index := set.Boolean(path); index != nil {
			indexes.Boolean[path] = index.Index()
		}
		if index := set.Enum(path); index != nil {
			indexes.Enum[path] = index.Index()
		}
		if index := set.Geo(path); index != nil {
			indexes.Geo[path] = index.Index()
		}
		if index := set.Pattern(path); index != nil {
			indexes.Pattern[path] = index.Index()
		}
		if present := set.Present(path); present != nil {
			indexes.Present[path] = present
		}
	}
	addColumns(&indexes, set)
	return indexes
}

func collectFrozen[T any](target map[string]T, entries []segments.Field[T]) {
	for _, entry := range entries {
		target[entry.Path] = entry.Index
	}
}

func frozenIndexes(segment *frozenSegment) query.FieldIndexes {
	indexes := emptyFieldIndexes()
	held := &segment.frozen.Fields
	collectFrozen(indexes.Numeric, held.Numeric)
	collectFrozen(indexes.Size, held.Sizes)
	collectFrozen(indexes.Boolean, held.Boolean)
	collectFrozen(indexes.Enum, held.Enum)
	collectFrozen(indexes.Geo, held.Geo)
	collectFrozen(indexes.Pattern, held.Pattern)
	for _, entry := range held.Stored {
		slices := core.StoredValueSlices(*entry.Index)
		indexes.Stored[entry.Path] = &slices
	}
	return indexes
}

func (f *frozenSide) querySegment() query.Segment {
	keyword := f.segment.keyword()
	built := query.Segment{
		Frozen:            &keyword.Segment,
		State:             &f.state.Core,
		Positions:         query.FrozenPositions{Offsets: keyword.PositionOffsets, Values: keyword.PositionValues},
		SpellingRuns:      &keyword.SpellingRuns,
		FrozenLengths:     keyword.FieldLengths,
		FrozenFieldTotals: f.totals,
		Fields:            frozenIndexes(f.segment),
	}
	if f.segment.paged != nil {
		built.Paged = f.segment.paged
	}
	return built
}

func (s *side) growingLive() []uint32 {
	words := max(1, (int(s.growing.View().OrdinalCapacity)+31)>>5)
	for len(s.live) < words {
		s.live = append(s.live, 0)
	}
	return s.live
}

func (s *side) refreshView(p *Partition) {
	view := &query.View{
		FieldNames: append([]string(nil), s.names.names[:s.viewFields]...),
		Schema:     p.schema,
		Segments:   make([]query.Segment, 0, len(s.frozen)+1),
	}
	for at := range s.frozen {
		view.Segments = append(view.Segments, s.frozen[at].querySegment())
	}
	view.Segments = append(view.Segments, query.Segment{
		Growing: s.growing.View(),
		Live:    s.growingLive(),
		Fields:  growingIndexes(s.fields, p.settings.ValueFields),
	})
	s.view = view
}

func (f *frozenSide) removeLengths(ordinal uint32) {
	for field, lengths := range f.segment.keyword().FieldLengths {
		if field < len(f.totals) && uint64(ordinal) < uint64(len(lengths)) {
			f.totals[field] -= float64(lengths[ordinal])
		}
	}
}

func newFrozenSide(segment *frozenSegment, state *segments.State) frozenSide {
	held := frozenSide{segment: segment, state: state,
		totals: append([]float64(nil), segment.keyword().TotalFieldLengths...)}
	for ordinal := range segment.documentCount() {
		if state.Tombstoned(ordinal) {
			held.removeLengths(ordinal)
		}
	}
	return held
}
