package results

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func OversampledShardSize(size int) int {
	widened := math.Ceil(float64(size) * shardOversampleFactor)
	if widened >= float64(math.MaxInt-shardOversampleExtra) {
		return math.MaxInt
	}
	return int(widened) + shardOversampleExtra
}

func keptFacetValues(config model.FacetFieldConfig) (int, bool) {
	limit, set := config.Limit.Get()
	if !set || limit <= 0 {
		return 0, false
	}
	return limit, true
}

func EveryValueFacetConfig(config model.FacetConfig) model.FacetConfig {
	widened := make(model.FacetConfig, len(config))
	for field, fieldConfig := range config {
		fieldConfig.Limit = model.Optional[int]{}
		widened[field] = fieldConfig
	}
	return widened
}

func OversampledFacetConfig(config model.FacetConfig) model.FacetConfig {
	widened := make(model.FacetConfig, len(config))
	for field, fieldConfig := range config {
		if fieldConfig.Ranges != nil || fieldConfig.Sort == model.SortAscending {
			fieldConfig.Limit = model.Optional[int]{}
			widened[field] = fieldConfig
			continue
		}
		if kept, limited := keptFacetValues(fieldConfig); limited {
			fieldConfig.Limit = model.Some(OversampledShardSize(kept))
		}
		widened[field] = fieldConfig
	}
	return widened
}

type mergedField struct {
	counts     map[string]int
	errorBound int
}

func MergeFacets(partitionFacets []map[string]model.FacetResult, config model.FacetConfig) map[string]model.FacetResult {
	merged := map[string]*mergedField{}
	for _, partition := range partitionFacets {
		for field, facet := range partition {
			entry, found := merged[field]
			if !found {
				entry = &mergedField{counts: map[string]int{}}
				merged[field] = entry
			}
			entry.errorBound += facet.ErrorBound
			for _, bucket := range facet.Values {
				entry.counts[bucket.Value] += bucket.Count
			}
		}
	}
	result := make(map[string]model.FacetResult, len(merged))
	for field, entry := range merged {
		fieldConfig := config[field]
		ascending := fieldConfig.Sort == model.SortAscending
		ordered := make([]model.FacetCount, 0, len(entry.counts))
		for value, count := range entry.counts {
			ordered = append(ordered, model.FacetCount{Value: value, Count: count})
		}
		slices.SortFunc(ordered, func(left, right model.FacetCount) int {
			if left.Count != right.Count {
				if ascending == (left.Count < right.Count) {
					return -1
				}
				return 1
			}
			return text.CompareCodePoints(left.Value, right.Value)
		})
		kept := len(ordered)
		if limit, limited := keptFacetValues(fieldConfig); limited {
			kept = min(limit, kept)
		}
		largestLeftOut := 0
		for _, bucket := range ordered[kept:] {
			largestLeftOut = max(largestLeftOut, bucket.Count)
		}
		result[field] = model.FacetResult{
			Values:     ordered[:kept:kept],
			Count:      kept,
			ErrorBound: entry.errorBound + largestLeftOut,
		}
	}
	return result
}
