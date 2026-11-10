package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/facets"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/filters"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type filterSource struct {
	sub partition.Sub
}

func (s filterSource) Capacity() int {
	return s.sub.OrdinalCapacity()
}

func (s filterSource) Live() bitset.Bits {
	return s.sub.Live()
}

func (s filterSource) Numeric(fieldPath string) *fieldindex.Numeric {
	return s.sub.NumericIndex(fieldPath)
}

func (s filterSource) Boolean(fieldPath string) *fieldindex.Boolean {
	return s.sub.BooleanIndex(fieldPath)
}

func (s filterSource) Enum(fieldPath string) *fieldindex.Enum {
	return s.sub.EnumIndex(fieldPath)
}

func (s filterSource) Geo(fieldPath string) *geo.Index {
	return s.sub.Geopoint(fieldPath)
}

func (s filterSource) Sizes(fieldPath string) *fieldindex.Numeric {
	return s.sub.ValueSizes(fieldPath)
}

func (s filterSource) PatternIndex(fieldPath string) (pattern.Reader, bool) {
	return s.sub.PatternIndex(fieldPath)
}

func (s filterSource) Document(ordinal uint32) (map[string]any, bool) {
	return s.sub.StoredDocument(ordinal)
}

func (s filterSource) Ordinal(id string) (uint32, bool) {
	return s.sub.OrdinalOf(id)
}

func (s filterSource) ExternalID(ordinal uint32) (string, bool) {
	document := s.sub.DocumentAt(ordinal)
	if document == nil {
		return "", false
	}
	return document.ID, true
}

type partitionFilter struct {
	compiled *filters.Filter
}

func (f *partitionFilter) matches(view partition.View) (bitset.Bits, error) {
	subs := view.Subs()
	if len(subs) == 1 {
		return filters.Evaluate(f.compiled, filterSource{sub: subs[0]})
	}
	combined := bitset.New(view.OrdinalCapacity())
	for _, sub := range subs {
		accepted, err := filters.Evaluate(f.compiled, filterSource{sub: sub})
		if err != nil {
			return nil, err
		}
		accepted.AndWith(sub.Live())
		sub.PlaceInto(combined, accepted)
	}
	return combined, nil
}

func (f *partitionFilter) matchingIDs(view partition.View) ([]string, error) {
	var ids []string
	for _, sub := range view.Subs() {
		matched, err := filters.MatchingIDs(f.compiled, filterSource{sub: sub})
		if err != nil {
			return nil, err
		}
		ids = append(ids, matched...)
	}
	return ids, nil
}

func (ix *Index) patternSearchFor(work *partition.WorkMeter) filters.PatternSearch {
	for _, field := range ix.settings.Schema.Fields() {
		if field.Pattern {
			return pattern.NewSearch(work)
		}
	}
	return nil
}

func (ix *Index) compileFilter(expression *model.FilterExpression, work *partition.WorkMeter) (*partitionFilter, error) {
	compiled, err := filters.Validate(expression, ix.settings.Schema, ix.patternSearchFor(work))
	if err != nil || compiled == nil {
		return nil, err
	}
	return &partitionFilter{compiled: compiled}, nil
}

func (ix *Index) facetsOf(view partition.View, outcome partitionOutcome, config model.FacetConfig) (map[string]model.FacetResult, error) {
	subs := view.Subs()
	if !view.HoldsFrozenSegments() {
		if outcome.holdsOrdinals {
			return facets.ComputeFacets(subs[0], outcome.matchedOrdinals, config, ix.settings.Schema), nil
		}
		return facets.ComputeFacetsForIDs(subs[0], outcome.matchedIDs, config, ix.settings.Schema), nil
	}
	everyValue := results.EveryValueFacetConfig(config)
	counted := make([]map[string]model.FacetResult, 0, len(subs))
	for _, sub := range subs {
		if outcome.holdsOrdinals {
			counted = append(counted, facets.ComputeFacets(sub, sub.Of(outcome.matchedOrdinals), everyValue, ix.settings.Schema))
			continue
		}
		counted = append(counted, facets.ComputeFacetsForIDs(sub, outcome.matchedIDs, everyValue, ix.settings.Schema))
	}
	return results.MergeFacets(counted, config), nil
}

type singleDocument struct {
	document *partition.StoredDocument
}

func (s singleDocument) StoredDocument(ordinal uint32) (map[string]any, bool) {
	if s.document == nil || ordinal != 0 {
		return nil, false
	}
	return s.document.Fields, true
}

func (s singleDocument) OrdinalOf(id string) (uint32, bool) {
	return 0, s.document != nil && s.document.ID == id
}

func (ix *Index) sortValuesOf(document *partition.StoredDocument, fields []string, modes []text.SortMode) []text.SortValue {
	if document == nil {
		return make([]text.SortValue, len(fields))
	}
	return facets.SortValues(singleDocument{document: document}, document.ID, fields, modes)
}
