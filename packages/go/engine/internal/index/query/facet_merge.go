package query

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func facetCountOf(value int) (uint32, error) {
	if value < 0 || value > math.MaxUint32 {
		return 0, narsilerr.New(narsilerr.CodeConfigInvalid, "A facet count must fit an unsigned 32-bit integer", map[string]any{"value": float64(value)})
	}
	return uint32(value), nil
}

type facetLists struct {
	lists  [][]model.FacetCount
	bounds []int
}

func groupFacetLists(results []map[string]model.FacetResult) ([]string, map[string]*facetLists) {
	var fields []string
	grouped := map[string]*facetLists{}
	for _, partition := range results {
		for field, result := range partition {
			merged := grouped[field]
			if merged == nil {
				merged = &facetLists{}
				grouped[field] = merged
				fields = append(fields, field)
			}
			merged.lists = append(merged.lists, result.Values)
			merged.bounds = append(merged.bounds, result.ErrorBound)
		}
	}
	slices.Sort(fields)
	return fields, grouped
}

func mergeFacetField(workspace *core.Workspace, merged *facetLists, options model.FacetFieldConfig) (model.FacetResult, error) {
	keys := map[string]uint32{}
	var labels []string
	entries := 0
	for _, list := range merged.lists {
		entries += len(list)
		if _, err := facetCountOf(entries); err != nil {
			return model.FacetResult{}, err
		}
		for _, bucket := range list {
			if _, err := facetCountOf(bucket.Count); err != nil {
				return model.FacetResult{}, err
			}
			if _, seen := keys[bucket.Value]; !seen {
				keys[bucket.Value] = uint32(len(labels))
				labels = append(labels, bucket.Value)
			}
		}
	}
	request := &core.FacetMergeRequest{
		Offsets: make([]uint32, len(merged.lists)+1), Values: make([]uint32, 0, entries), Counts: make([]uint32, 0, entries),
		Bounds: make([]uint32, len(merged.bounds)), ValueRanks: make([]uint32, len(labels)),
		Ascending: options.Sort == model.SortAscending, HasLimit: true,
	}
	undercount := 0
	for at, bound := range merged.bounds {
		value, err := facetCountOf(bound)
		if err != nil {
			return model.FacetResult{}, err
		}
		undercount += bound
		request.Bounds[at] = value
	}
	if _, err := facetCountOf(undercount); err != nil {
		return model.FacetResult{}, err
	}
	for source, list := range merged.lists {
		request.Offsets[source] = uint32(len(request.Values))
		for _, bucket := range list {
			request.Values = append(request.Values, keys[bucket.Value])
			request.Counts = append(request.Counts, uint32(bucket.Count))
		}
	}
	request.Offsets[len(merged.lists)] = uint32(len(request.Values))
	ordered := make([]uint32, len(labels))
	for key := range ordered {
		ordered[key] = uint32(key)
	}
	slices.SortStableFunc(ordered, func(left, right uint32) int { return text.CompareCodePoints(labels[left], labels[right]) })
	for rank, key := range ordered {
		request.ValueRanks[key] = uint32(rank)
	}
	size := len(labels)
	if limit, set := keptFacetValues(options.Limit); set {
		size = min(limit, size)
	}
	request.Limit = uint32(size)
	output := &core.FacetMergeOutput{Values: make([]uint32, size), Counts: make([]uint32, size), ErrorBound: make([]uint32, 1)}
	found, err := workspace.MergeFacets(request, output)
	if err != nil {
		return model.FacetResult{}, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The facet lists cannot be merged", err, nil)
	}
	result := model.FacetResult{Values: make([]model.FacetCount, found), Count: int(found), ErrorBound: int(output.ErrorBound[0])}
	for at := range found {
		result.Values[at] = model.FacetCount{Value: labels[output.Values[at]], Count: int(output.Counts[at])}
	}
	return result, nil
}

func mergeFacetsWith(workspace *core.Workspace, results []map[string]model.FacetResult, config model.FacetConfig) (map[string]model.FacetResult, error) {
	fields, grouped := groupFacetLists(results)
	merged := make(map[string]model.FacetResult, len(fields))
	for _, field := range fields {
		result, err := mergeFacetField(workspace, grouped[field], config[field])
		if err != nil {
			return nil, err
		}
		merged[field] = result
	}
	return merged, nil
}

func MergeFacets(results []map[string]model.FacetResult, config model.FacetConfig) (map[string]model.FacetResult, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	return mergeFacetsWith(workspace, results, config)
}
