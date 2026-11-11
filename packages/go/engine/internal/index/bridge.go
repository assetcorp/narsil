package index

import (
	"math/bits"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type filterRun struct {
	run        *query.FilterRun
	expression *model.FilterExpression
}

func (ix *Index) validateFilter(expression *model.FilterExpression) error {
	if expression == nil {
		return nil
	}
	return query.ValidateFilter(expression, ix.settings.Schema, pattern.CheckOperands)
}

func newFilterRun(expression *model.FilterExpression, work *query.Work) (*filterRun, error) {
	if expression == nil {
		return nil, nil
	}
	run, err := query.NewFilterRun(work)
	if err != nil {
		return nil, err
	}
	return &filterRun{run: run, expression: expression}, nil
}

func (f *filterRun) release() {
	if f != nil {
		f.run.Release()
	}
}

func (f *filterRun) evaluate(view *query.View) ([][]uint32, error) {
	return f.run.Evaluate(view, f.expression)
}

func anyBitSet(matched [][]uint32) bool {
	for _, segment := range matched {
		for _, word := range segment {
			if word != 0 {
				return true
			}
		}
	}
	return false
}

func eachOrdinal(words []uint32, visit func(ordinal uint32)) {
	for word, held := range words {
		for held != 0 {
			bit := bits.TrailingZeros32(held)
			visit(uint32(word<<5 + bit))
			held &= held - 1
		}
	}
}

func matchingIDs(snapshot partition.Snapshot, matched [][]uint32) ([]string, error) {
	var ids []string
	var failure error
	for segment, words := range matched {
		eachOrdinal(words, func(ordinal uint32) {
			if failure != nil {
				return
			}
			id, live, err := snapshot.IDAt(segment, ordinal)
			if err != nil {
				failure = err
			} else if live {
				ids = append(ids, id)
			}
		})
	}
	return ids, failure
}

func indexedFacetBase(base schema.BaseFieldType) bool {
	switch base {
	case schema.BaseNumber, schema.BaseNumberList, schema.BaseEnum, schema.BaseEnumList, schema.BaseBoolean, schema.BaseBooleanList:
		return true
	}
	return false
}

func addColumn(requests []partition.ColumnRequest, request partition.ColumnRequest) []partition.ColumnRequest {
	for _, held := range requests {
		if held == request {
			return requests
		}
	}
	return append(requests, request)
}

func (ix *Index) columnRequests(params *model.QueryParams, groupFields []string) []partition.ColumnRequest {
	var requests []partition.ColumnRequest
	for _, field := range params.Sort {
		requests = addColumn(requests, partition.ColumnRequest{Path: field.Field, Sort: true, Mode: query.SortModeOf(field)})
	}
	filter, facets := params.Filters, params.Facets
	if filter != nil {
		for _, path := range query.FilterSortFields(filter) {
			requests = addColumn(requests, partition.ColumnRequest{Path: path, Sort: true, Mode: core.SortMin})
		}
		for _, path := range query.FilteredFields(filter) {
			if field, declared := ix.settings.Schema.Field(path); declared && field.Pattern {
				requests = addColumn(requests, partition.ColumnRequest{Path: path})
			}
		}
	}
	for _, path := range facetFieldOrder(facets) {
		if field, declared := ix.settings.Schema.Field(path); declared && indexedFacetBase(field.Base) {
			continue
		}
		requests = addColumn(requests, partition.ColumnRequest{Path: path})
	}
	for _, path := range groupFields {
		requests = addColumn(requests, partition.ColumnRequest{Path: path})
	}
	return requests
}

func everyValueFacetConfig(config model.FacetConfig) model.FacetConfig {
	widened := make(model.FacetConfig, len(config))
	for field, fieldConfig := range config {
		fieldConfig.Limit = model.Optional[int]{}
		widened[field] = fieldConfig
	}
	return widened
}

func facetsOf(view *query.View, matched [][]uint32, config model.FacetConfig) (map[string]model.FacetResult, error) {
	if len(matched) != len(view.Segments) {
		matched = make([][]uint32, len(view.Segments))
	}
	return query.Facets(view, matched, config)
}
