package partition

import (
	"maps"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
)

type frozenColumns struct {
	stored map[string]*fields.Stored
	sorts  map[string]*fields.SortColumn
}

func (c *frozenColumns) clone() *frozenColumns {
	next := &frozenColumns{stored: map[string]*fields.Stored{}, sorts: map[string]*fields.SortColumn{}}
	if c != nil {
		maps.Copy(next.stored, c.stored)
		maps.Copy(next.sorts, c.sorts)
	}
	return next
}

func (c *frozenColumns) release() {
	if c == nil {
		return
	}
	for _, stored := range c.stored {
		stored.Release()
	}
	for _, column := range c.sorts {
		column.Release()
	}
}

func (f *frozenSegment) builtStored(path string) *fields.Stored {
	if held := f.columns.Load(); held != nil {
		return held.stored[path]
	}
	return nil
}

func (f *frozenSegment) builtSort(key string) *fields.SortColumn {
	if held := f.columns.Load(); held != nil {
		return held.sorts[key]
	}
	return nil
}

func (f *frozenSegment) storedSource(path string, limits fields.Limits) (fields.StoredSource, *core.StoredValueSlices, error) {
	for _, entry := range f.frozen.Fields.Stored {
		if entry.Path == path {
			slices := core.StoredValueSlices(*entry.Index)
			return fields.StoredRegionsSource(entry.Index), &slices, nil
		}
	}
	if held := f.builtStored(path); held != nil {
		slices := held.Slices()
		return held, &slices, nil
	}
	built, err := buildStored(path, limits, f.documentCount(), f.documentAt)
	if err != nil {
		return nil, nil, err
	}
	for {
		current := f.columns.Load()
		if current != nil && current.stored[path] != nil {
			built.Release()
			held := current.stored[path]
			slices := held.Slices()
			return held, &slices, nil
		}
		next := current.clone()
		next.stored[path] = built
		if f.columns.CompareAndSwap(current, next) {
			slices := built.Slices()
			return built, &slices, nil
		}
	}
}

func everyOrdinal(count uint32) []uint32 {
	words := max(1, (uint64(count)+31)>>5)
	live := make([]uint32, words)
	for at := range live {
		live[at] = math.MaxUint32
	}
	if tail := count & 31; tail != 0 {
		live[words-1] = 1<<tail - 1
	}
	return live
}

func (f *frozenSegment) sortColumn(p *Partition, request ColumnRequest) (*fields.SortColumn, error) {
	key := p.sortKey(request)
	if held := f.builtSort(key); held != nil {
		return held, nil
	}
	source, _, err := f.storedSource(request.Path, p.settings.Limits)
	if err != nil {
		return nil, err
	}
	built, err := fields.BuildSortColumn(request.Path, request.Mode, source, p.settings.Limits, f.documentCount(),
		everyOrdinal(f.documentCount()))
	if err != nil {
		return nil, err
	}
	for {
		current := f.columns.Load()
		if current != nil && current.sorts[key] != nil {
			built.Release()
			return current.sorts[key], nil
		}
		next := current.clone()
		next.sorts[key] = built
		if f.columns.CompareAndSwap(current, next) {
			return built, nil
		}
	}
}
