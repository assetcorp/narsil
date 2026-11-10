package query

import (
	"cmp"
	"slices"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	storedKindFalse  = 1
	storedKindTrue   = 2
	storedKindNumber = 3
)

func facetFailure(err error) error {
	return narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The facet could not be counted", err, nil)
}

func keptFacetValues(limit model.Optional[int]) (int, bool) {
	if value, set := limit.Get(); set && value > 0 {
		return value, true
	}
	return 0, false
}

func matchedOrEmpty(matched []uint32) []uint32 {
	if len(matched) == 0 {
		return make([]uint32, 1)
	}
	return matched
}

func enumNames(index *core.EnumIndex) []string {
	names := make([]string, max(0, len(index.Offsets)-1))
	for at := range names {
		start, end := index.Offsets[at], index.Offsets[at+1]
		if start <= end && int(end) <= len(index.Units) {
			names[at] = string(utf16.Decode(index.Units[start:end]))
		}
	}
	return names
}

type facetCounter struct {
	workspace *core.Workspace
	segment   *Segment
	matched   []uint32
}

func (c *facetCounter) ranges(path string, ranges []model.FacetRange) (map[string]int, error) {
	bounds := make([]float64, 0, 2*len(ranges))
	for _, entry := range ranges {
		bounds = append(bounds, entry.From, entry.To)
	}
	totals := make([]uint32, len(ranges))
	var err error
	if index := c.segment.Fields.Numeric[path]; index != nil {
		err = c.workspace.RangeFacet(index, c.matched, bounds, totals)
	} else if stored := c.segment.Fields.Stored[path]; stored != nil {
		err = core.StoredRangeFacet(stored.Values(), c.matched, bounds, totals)
	}
	if err != nil {
		return nil, facetFailure(err)
	}
	counts := make(map[string]int, len(ranges))
	for at, entry := range ranges {
		counts[text.FormatNumber(entry.From)+"-"+text.FormatNumber(entry.To)] = int(totals[at])
	}
	return counts, nil
}

func (c *facetCounter) values(path string, base schema.BaseFieldType) (map[string]int, error) {
	counts := map[string]int{}
	switch base {
	case schema.BaseEnum, schema.BaseEnumList:
		if index := c.segment.Fields.Enum[path]; index != nil {
			names := enumNames(index)
			totals := make([]uint32, len(names))
			if err := c.workspace.EnumFacet(index, c.matched, totals); err != nil {
				return nil, facetFailure(err)
			}
			for at, name := range names {
				if totals[at] > 0 {
					counts[name] = int(totals[at])
				}
			}
			return counts, nil
		}
	case schema.BaseBoolean, schema.BaseBooleanList:
		if index := c.segment.Fields.Boolean[path]; index != nil {
			totals := make([]uint32, core.BooleanFacetCounts)
			if err := core.BooleanFacet(index, c.matched, totals); err != nil {
				return nil, facetFailure(err)
			}
			if totals[core.BooleanFacetTrueSlot] > 0 {
				counts["true"] = int(totals[core.BooleanFacetTrueSlot])
			}
			if totals[core.BooleanFacetFalseSlot] > 0 {
				counts["false"] = int(totals[core.BooleanFacetFalseSlot])
			}
			return counts, nil
		}
	case schema.BaseNumber, schema.BaseNumberList:
		if index := c.segment.Fields.Numeric[path]; index != nil {
			values := make([]float64, len(index.Values))
			totals := make([]uint32, len(index.Values))
			found, err := c.workspace.NumberFacet(index, c.matched, values, totals)
			if err != nil {
				return nil, facetFailure(err)
			}
			for at := range found {
				counts[text.FormatNumber(values[at])] = int(totals[at])
			}
			return counts, nil
		}
	}
	return c.storedValues(path, counts)
}

func (c *facetCounter) storedValues(path string, counts map[string]int) (map[string]int, error) {
	stored := c.segment.Fields.Stored[path]
	if stored == nil {
		return counts, nil
	}
	positions := make([]uint32, len(stored.Kinds))
	totals := make([]uint32, len(stored.Kinds))
	found, err := c.workspace.ValueFacet(stored.Values(), c.matched, positions, totals)
	if err != nil {
		return nil, facetFailure(err)
	}
	for at := range found {
		key, held := storedKey(stored, positions[at])
		if !held {
			return nil, narsilerr.New(narsilerr.CodePartitionCorrupted, "A stored value of the partition view lies outside its regions", map[string]any{"field": path})
		}
		counts[key] += int(totals[at])
	}
	return counts, nil
}

func storedKey(stored *core.StoredValueSlices, position uint32) (string, bool) {
	if int(position) >= len(stored.Kinds) {
		return "", false
	}
	switch stored.Kinds[position] {
	case storedKindFalse:
		return "false", true
	case storedKindTrue:
		return "true", true
	case storedKindNumber:
		if int(position) >= len(stored.Numbers) {
			return "", false
		}
		return text.FormatNumber(stored.Numbers[position]), true
	}
	if int(position) >= len(stored.TextStart) || int(position) >= len(stored.TextLength) {
		return "", false
	}
	start, length := uint64(stored.TextStart[position]), uint64(stored.TextLength[position])
	if start+length > uint64(len(stored.Units)) {
		return "", false
	}
	return string(utf16.Decode(stored.Units[start : start+length])), true
}

type facetEntry struct {
	value string
	count int
}

func orderedFacet(counts map[string]int, options model.FacetFieldConfig) model.FacetResult {
	ordered := make([]facetEntry, 0, len(counts))
	for value, count := range counts {
		ordered = append(ordered, facetEntry{value, count})
	}
	ascending := options.Sort == model.SortAscending
	slices.SortFunc(ordered, func(left, right facetEntry) int {
		byCount := cmp.Compare(right.count, left.count)
		if ascending {
			byCount = -byCount
		}
		if byCount != 0 {
			return byCount
		}
		return text.CompareCodePoints(left.value, right.value)
	})
	keep := len(ordered)
	if limit, set := keptFacetValues(options.Limit); set {
		keep = min(limit, keep)
	}
	result := model.FacetResult{Values: make([]model.FacetCount, keep), Count: keep}
	for at, entry := range ordered {
		if at < keep {
			result.Values[at] = model.FacetCount{Value: entry.value, Count: entry.count}
		} else {
			result.ErrorBound = max(result.ErrorBound, entry.count)
		}
	}
	return result
}

func segmentFacets(workspace *core.Workspace, view *View, index int, matched []uint32, config model.FacetConfig, everyValue bool) (map[string]model.FacetResult, error) {
	counter := &facetCounter{workspace: workspace, segment: &view.Segments[index], matched: matchedOrEmpty(matched)}
	results := make(map[string]model.FacetResult, len(config))
	for path, options := range config {
		parsed, declared := view.Schema[path]
		base := parsed.Base
		var counts map[string]int
		var err error
		numeric := base == schema.BaseNumber || base == schema.BaseNumberList || !declared
		if options.Ranges != nil && numeric {
			counts, err = counter.ranges(path, options.Ranges)
		} else {
			counts, err = counter.values(path, base)
		}
		if err != nil {
			return nil, err
		}
		if everyValue {
			options.Limit = model.Optional[int]{}
		}
		results[path] = orderedFacet(counts, options)
	}
	return results, nil
}

func Facets(view *View, matched [][]uint32, config model.FacetConfig) (map[string]model.FacetResult, error) {
	if err := validateView(view); err != nil {
		return nil, err
	}
	if len(matched) != len(view.Segments) {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The matched sets do not cover every segment of the partition view", nil)
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	if len(view.Segments) == 1 {
		return segmentFacets(workspace, view, 0, matched[0], config, false)
	}
	lists := make([]map[string]model.FacetResult, len(view.Segments))
	for index := range view.Segments {
		if lists[index], err = segmentFacets(workspace, view, index, matched[index], config, true); err != nil {
			return nil, err
		}
	}
	return mergeFacetsWith(workspace, lists, config)
}
