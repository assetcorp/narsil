package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func growingFields(set *fields.Set, declared []schema.Field) *segments.GrowingFields {
	collected := &segments.GrowingFields{}
	for _, field := range declared {
		path := field.Path
		if index := set.Numeric(path); index != nil {
			collected.Numeric = append(collected.Numeric, segments.Field[*core.NumericIndex]{Path: path, Index: index.Index()})
		}
		if index := set.Sizes(path); index != nil {
			collected.Sizes = append(collected.Sizes, segments.Field[*core.NumericIndex]{Path: path, Index: index.Index()})
		}
		if index := set.Boolean(path); index != nil {
			collected.Boolean = append(collected.Boolean, segments.Field[*core.BooleanIndex]{Path: path, Index: index.Index()})
		}
		if index := set.Enum(path); index != nil {
			collected.Enum = append(collected.Enum, segments.Field[*core.EnumIndex]{Path: path, Index: index.Index()})
		}
		if index := set.Geo(path); index != nil {
			collected.Geo = append(collected.Geo, segments.Field[*core.GeoIndex]{Path: path, Index: index.Index()})
		}
		if index := set.Pattern(path); index != nil {
			collected.Pattern = append(collected.Pattern, segments.Field[*core.PatternIndex]{Path: path, Index: index.Index()})
		}
	}
	for _, path := range set.StoredFields() {
		if stored := set.Stored(path); stored != nil {
			collected.Stored = append(collected.Stored, segments.Field[*core.StoredValues]{Path: path, Index: stored.Values()})
		}
	}
	return collected
}

func (s *side) partialFieldNames() []string {
	var names []string
	for _, name := range s.names.names[:s.fieldCount] {
		if s.names.partial[name] {
			names = append(names, name)
		}
	}
	return names
}

func (s *side) freezeGrowing(w *core.Workspace, declared []schema.Field, columns []ColumnRequest) (*freezeResult, error) {
	if err := s.growing.EndBatch(); err != nil {
		return nil, err
	}
	if err := s.fields.Settle(s.capacity); err != nil {
		return nil, err
	}
	mapping := make([]uint32, s.capacity)
	ids := make([]string, 0, s.liveCount)
	documents := make([][]byte, 0, s.liveCount)
	for ordinal := range s.capacity {
		mapping[ordinal] = core.MergeDroppedOrdinal
		if !s.holdsLive(ordinal) {
			continue
		}
		document, held := s.gen.documents.at(s.index, ordinal)
		if !held {
			return nil, corruptedPartition("a live growing ordinal holds no stored document", ordinal)
		}
		mapping[ordinal] = uint32(len(ids))
		ids = append(ids, document.id)
		documents = append(documents, document.encoded)
	}
	frozen, err := segments.Freeze(w, segments.GrowingInput{
		Segment:           s.growing.View(),
		FieldNames:        append([]string(nil), s.names.names[:s.fieldCount]...),
		PartialFieldNames: s.partialFieldNames(),
		Mapping:           mapping,
		Fields:            growingFields(s.fields, declared),
	})
	if err != nil {
		return nil, err
	}
	return &freezeResult{segment: newFrozenSegment(frozen, ids, documents), next: newGeneration(), columns: columns}, nil
}

func (s *side) restart(p *Partition, result *freezeResult) error {
	fresh, err := p.newSide(s.index, result.next)
	if err != nil {
		return err
	}
	s.release()
	s.gen, s.growing, s.fields = result.next, fresh.growing, fresh.fields
	s.fieldCount, s.capacity, s.liveCount = 0, 0, 0
	s.ids, s.live = map[string]uint32{}, nil
	if err := s.growing.BeginBatch(); err != nil {
		return err
	}
	return s.keepColumns(result.columns)
}

func (s *side) installFreeze(p *Partition, result *freezeResult) error {
	if err := s.restart(p, result); err != nil {
		return err
	}
	s.frozen = append(s.frozen[:len(s.frozen):len(s.frozen)], newFrozenSide(result.segment, result.segment.newState()))
	return nil
}

func (s *side) clear(p *Partition, result *freezeResult) error {
	if err := s.restart(p, result); err != nil {
		return err
	}
	s.frozen = nil
	return nil
}
