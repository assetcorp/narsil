package partition

import (
	"maps"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
)

type searchColumns struct {
	view    *query.View
	cloned  []bool
	stored  map[string]*fields.Stored
	columns []*fields.SortColumn
}

func (c *searchColumns) indexes(segment int) *query.FieldIndexes {
	held := &c.view.Segments[segment].Fields
	if !c.cloned[segment] {
		held.Stored = maps.Clone(held.Stored)
		held.Sort = maps.Clone(held.Sort)
		c.cloned[segment] = true
	}
	return held
}

func (c *searchColumns) release() {
	for _, stored := range c.stored {
		stored.Release()
	}
	for _, column := range c.columns {
		column.Release()
	}
}

func sortColumnKey(column *fields.SortColumn) query.SortColumnKey {
	return query.SortColumnKey{Field: column.Field(), Mode: column.Mode()}
}

func (s Snapshot) frozenColumn(c *searchColumns, segment int, request ColumnRequest) error {
	held := s.side.frozen[segment].segment
	limits := s.partition.settings.Limits
	if !request.Sort {
		_, slices, err := held.storedSource(request.Path, limits)
		if err == nil {
			c.indexes(segment).Stored[request.Path] = slices
		}
		return err
	}
	column, err := held.sortColumn(s.partition, request)
	if err == nil {
		c.indexes(segment).Sort[sortColumnKey(column)] = column.Column()
	}
	return err
}

func (s Snapshot) growingLiveBits() []uint32 {
	words := max(1, (int(s.side.capacity)+31)>>5)
	live := make([]uint32, words)
	copy(live, s.side.live)
	return live
}

func (s Snapshot) growingStored(c *searchColumns, path string) (fields.StoredSource, error) {
	if held := s.side.fields.Stored(path); held != nil {
		return held, nil
	}
	if held := c.stored[path]; held != nil {
		return held, nil
	}
	built, err := buildStored(path, s.partition.settings.Limits, s.side.capacity, s.side.growingDocument)
	if err != nil {
		return nil, err
	}
	c.stored[path] = built
	slices := built.Slices()
	c.indexes(len(s.side.frozen)).Stored[path] = &slices
	return built, nil
}

func (s Snapshot) growingColumn(c *searchColumns, request ColumnRequest) error {
	if holdsColumn(s.side.fields, request) {
		return nil
	}
	s.partition.settings.Kept.Add(request)
	source, err := s.growingStored(c, request.Path)
	if err != nil || !request.Sort {
		return err
	}
	column, err := fields.BuildSortColumn(request.Path, request.Mode, source, s.partition.settings.Limits,
		s.side.capacity, s.growingLiveBits())
	if err != nil {
		return err
	}
	c.columns = append(c.columns, column)
	c.indexes(len(s.side.frozen)).Sort[sortColumnKey(column)] = column.Column()
	return nil
}

func (s Snapshot) ViewWith(requests []ColumnRequest) (*query.View, func(), error) {
	base := s.side.view
	if len(requests) == 0 {
		return base, func() {}, nil
	}
	view := *base
	view.Segments = slices.Clone(base.Segments)
	c := &searchColumns{view: &view, cloned: make([]bool, len(view.Segments)), stored: map[string]*fields.Stored{}}
	for _, request := range requests {
		for segment := range s.side.frozen {
			if err := s.frozenColumn(c, segment, request); err != nil {
				c.release()
				return nil, nil, err
			}
		}
		if err := s.growingColumn(c, request); err != nil {
			c.release()
			return nil, nil, err
		}
	}
	return &view, c.release, nil
}

func (s *side) growingDocument(ordinal uint32) (storedDocument, bool, error) {
	if !s.holdsLive(ordinal) {
		return storedDocument{}, false, nil
	}
	document, held := s.gen.documents.at(s.index, ordinal)
	return document, held, nil
}
