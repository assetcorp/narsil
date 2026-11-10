package facets

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func KeptFacetValues(limit model.Optional[int]) (int, bool) {
	kept, set := limit.Get()
	if !set || kept <= 0 {
		return 0, false
	}
	return kept, true
}

func SettleFacetedNumbers(indexes NumericIndexes, config model.FacetConfig, parsed *schema.Parsed) {
	for fieldPath := range config {
		shape := shapeOf(parsed, fieldPath)
		if !shape.declared || (shape.base != schema.BaseNumber && shape.base != schema.BaseNumberList) {
			continue
		}
		if index := indexes.NumericIndex(fieldPath); index != nil {
			index.Settle()
		}
	}
}

func ComputeFacetsForIDs(source Source, ids []string, config model.FacetConfig, parsed *schema.Parsed) map[string]model.FacetResult {
	return ComputeFacets(source, MatchedOrdinalsOf(source, ids), config, parsed)
}

func ComputeFacets(source Source, matched bitset.Bits, config model.FacetConfig, parsed *schema.Parsed) map[string]model.FacetResult {
	results := make(map[string]model.FacetResult, len(config))
	for fieldPath, fieldConfig := range config {
		shape := shapeOf(parsed, fieldPath)
		var counts map[string]int
		if fieldConfig.Ranges != nil && shape.countsRanges() {
			counts = countNumericRanges(source, fieldPath, shape, fieldConfig.Ranges, matched)
		} else {
			counts = countFieldValues(source, fieldPath, shape, matched)
		}
		results[fieldPath] = facetResultOf(counts, fieldConfig)
	}
	return results
}

func facetResultOf(counts map[string]int, fieldConfig model.FacetFieldConfig) model.FacetResult {
	ordered := make([]model.FacetCount, 0, len(counts))
	for value, count := range counts {
		ordered = append(ordered, model.FacetCount{Value: value, Count: count})
	}
	ascending := fieldConfig.Sort == model.SortAscending
	slices.SortFunc(ordered, func(left, right model.FacetCount) int {
		difference := right.Count - left.Count
		if ascending {
			difference = -difference
		}
		if difference != 0 {
			return difference
		}
		return text.CompareCodePoints(left.Value, right.Value)
	})
	keep := len(ordered)
	if limit, limited := KeptFacetValues(fieldConfig.Limit); limited && limit < keep {
		keep = limit
	}
	if keep == len(ordered) {
		return model.FacetResult{Values: ordered, Count: keep}
	}
	errorBound := 0
	for _, dropped := range ordered[keep:] {
		errorBound = max(errorBound, dropped.Count)
	}
	return model.FacetResult{Values: slices.Clone(ordered[:keep]), Count: keep, ErrorBound: errorBound}
}
