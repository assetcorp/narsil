package segments

import (
	"fmt"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type fieldMerge[T any, O any] struct {
	kind     core.FieldMergeKind
	source   func(T) core.FieldIndex
	empty    func(documents uint32) core.FieldIndex
	allocate func(core.FieldMergeSizes) (O, core.FieldIndex)
}

func (m fieldMerge[T, O]) merge(w *core.Workspace, inputs [][]Field[T], mappings [][]uint32, count uint32) ([]Field[O], error) {
	var paths []string
	for _, entries := range inputs {
		for _, entry := range entries {
			if !slices.Contains(paths, entry.Path) {
				paths = append(paths, entry.Path)
			}
		}
	}
	merged := make([]Field[O], 0, len(paths))
	for _, path := range paths {
		sources := make([]core.FieldMergeSource, len(inputs))
		for at, entries := range inputs {
			index := m.empty(uint32(len(mappings[at])))
			for _, entry := range entries {
				if entry.Path == path {
					index = m.source(entry.Index)
				}
			}
			sources[at] = core.FieldMergeSource{Mapping: mappings[at], Index: index}
		}
		request := &core.FieldMergeRequest{Kind: m.kind, DocumentCount: count, Sources: sources}
		sizes, err := w.MeasureFieldMerge(request)
		if err != nil {
			return nil, fmt.Errorf("measuring the merge of field %q: %w", path, err)
		}
		output, target := m.allocate(sizes)
		if err := w.WriteFieldMerge(request, target); err != nil {
			return nil, fmt.Errorf("writing the merge of field %q: %w", path, err)
		}
		merged = append(merged, Field[O]{Path: path, Index: output})
	}
	return merged, nil
}

func same[T core.FieldIndex](index T) core.FieldIndex {
	return index
}

var numericMerge = fieldMerge[*core.NumericIndex, *core.NumericIndex]{
	kind:   core.FieldMergeNumeric,
	source: same[*core.NumericIndex],
	empty:  func(uint32) core.FieldIndex { return &core.NumericIndex{} },
	allocate: func(sizes core.FieldMergeSizes) (*core.NumericIndex, core.FieldIndex) {
		index := &core.NumericIndex{Values: make([]float64, sizes[0]), Ordinals: make([]uint32, sizes[1])}
		return index, index
	},
}

var booleanMerge = fieldMerge[*core.BooleanIndex, *core.BooleanIndex]{
	kind:   core.FieldMergeBoolean,
	source: same[*core.BooleanIndex],
	empty: func(documents uint32) core.FieldIndex {
		words := bitsetWords(documents)
		return &core.BooleanIndex{TrueBits: make([]uint32, words), FalseBits: make([]uint32, words)}
	},
	allocate: func(sizes core.FieldMergeSizes) (*core.BooleanIndex, core.FieldIndex) {
		index := &core.BooleanIndex{TrueBits: make([]uint32, sizes[0]), FalseBits: make([]uint32, sizes[1])}
		return index, index
	},
}

var enumMerge = fieldMerge[*core.EnumIndex, *core.EnumIndex]{
	kind:   core.FieldMergeEnum,
	source: same[*core.EnumIndex],
	empty: func(uint32) core.FieldIndex {
		return &core.EnumIndex{Offsets: []uint32{0}, PostingOffsets: []uint32{0}}
	},
	allocate: func(sizes core.FieldMergeSizes) (*core.EnumIndex, core.FieldIndex) {
		index := &core.EnumIndex{
			Units: make([]uint16, sizes[0]), Offsets: make([]uint32, sizes[1]), PostingOffsets: make([]uint32, sizes[2]),
			Postings: make([]uint32, sizes[3]), SuffixOrder: make([]uint32, sizes[4]),
		}
		return index, index
	},
}

var geoMerge = fieldMerge[*core.GeoIndex, *core.GeoIndex]{
	kind:   core.FieldMergeGeo,
	source: same[*core.GeoIndex],
	empty:  func(uint32) core.FieldIndex { return &core.GeoIndex{} },
	allocate: func(sizes core.FieldMergeSizes) (*core.GeoIndex, core.FieldIndex) {
		index := &core.GeoIndex{
			Codes: make([]uint64, sizes[0]), Lat: make([]float64, sizes[1]), Lon: make([]float64, sizes[2]),
			Ordinals: make([]uint32, sizes[3]),
		}
		return index, index
	},
}

var patternMerge = fieldMerge[*core.PatternIndex, *core.PatternIndex]{
	kind:   core.FieldMergePattern,
	source: same[*core.PatternIndex],
	empty:  func(uint32) core.FieldIndex { return &core.PatternIndex{Offsets: []uint32{0}} },
	allocate: func(sizes core.FieldMergeSizes) (*core.PatternIndex, core.FieldIndex) {
		index := &core.PatternIndex{
			Documents: make([]uint32, sizes[0]), Runs: make([]uint32, sizes[1]), Offsets: make([]uint32, sizes[2]),
			Postings: make([]uint32, sizes[3]),
		}
		return index, index
	},
}

func storedMerge[T any](source func(T) core.FieldIndex) fieldMerge[T, *core.StoredValueRegions] {
	return fieldMerge[T, *core.StoredValueRegions]{
		kind:   core.FieldMergeStored,
		source: source,
		empty:  func(documents uint32) core.FieldIndex { return core.EmptyStoredValueRegions(documents).Values() },
		allocate: func(sizes core.FieldMergeSizes) (*core.StoredValueRegions, core.FieldIndex) {
			regions := core.NewStoredValueRegions(sizes)
			return regions, regions.Values()
		},
	}
}

func bitsetWords(documents uint32) int {
	return max(1, int((uint64(documents)+31)/32))
}

func mergeFieldSets[S any](w *core.Workspace, sets []*FieldSet[S], stored func(S) core.FieldIndex, mappings [][]uint32,
	count uint32) (FrozenFields, error) {
	var merged FrozenFields
	var err error
	if merged.Numeric, err = numericMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.NumericIndex] { return s.Numeric }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	if merged.Sizes, err = numericMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.NumericIndex] { return s.Sizes }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	if merged.Boolean, err = booleanMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.BooleanIndex] { return s.Boolean }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	if merged.Enum, err = enumMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.EnumIndex] { return s.Enum }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	if merged.Geo, err = geoMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.GeoIndex] { return s.Geo }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	if merged.Pattern, err = patternMerge.merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[*core.PatternIndex] { return s.Pattern }), mappings, count); err != nil {
		return FrozenFields{}, err
	}
	merged.Stored, err = storedMerge(stored).merge(w, columnsOf(sets, func(s *FieldSet[S]) []Field[S] { return s.Stored }), mappings, count)
	if err != nil {
		return FrozenFields{}, err
	}
	return merged, nil
}

func columnsOf[S any, T any](sets []*FieldSet[S], column func(*FieldSet[S]) []Field[T]) [][]Field[T] {
	columns := make([][]Field[T], len(sets))
	for at, set := range sets {
		if set != nil {
			columns[at] = column(set)
		}
	}
	return columns
}

func growingStored(values *core.StoredValues) core.FieldIndex {
	return values
}

func frozenStored(regions *core.StoredValueRegions) core.FieldIndex {
	if regions == nil {
		return (*core.StoredValues)(nil)
	}
	return regions.Values()
}
