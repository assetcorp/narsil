package index

import (
	"math"
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/facets"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func arrayIndexKey(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	value, err := strconv.ParseUint(key, 10, 64)
	if err != nil || value > math.MaxUint32-1 {
		return 0, false
	}
	return value, true
}

func objectKeyOrder[V any](entries map[string]V) []string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool {
		leftIndex, leftIsIndex := arrayIndexKey(keys[left])
		rightIndex, rightIsIndex := arrayIndexKey(keys[right])
		switch {
		case leftIsIndex && rightIsIndex:
			return leftIndex < rightIndex
		case leftIsIndex != rightIsIndex:
			return leftIsIndex
		}
		return text.CompareCodePoints(keys[left], keys[right]) < 0
	})
	return keys
}

func requireIntegerUpTo(option string, value model.Optional[int], maximum int) error {
	held, set := value.Get()
	if !set || held >= 0 && held <= maximum {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		`The query option "`+option+`" takes an integer from 0 to `+strconv.Itoa(maximum)+`, and this query sets `+strconv.Itoa(held),
		map[string]any{"option": option, "value": strconv.Itoa(held), "maximum": maximum})
}

func requireValidTypoTolerance(query *model.QueryParams) error {
	if err := requireIntegerUpTo("tolerance", query.Tolerance, maxTolerance); err != nil {
		return err
	}
	return requireIntegerUpTo("prefixLength", query.PrefixLength, maxPrefixLength)
}

func leadingUTF16(value string, limit int) string {
	units := text.EncodeUTF16(value)
	if len(units) <= limit {
		return value
	}
	return text.DecodeUTF16(units[:limit])
}

func requireBM25Value(label string, value model.Optional[float64], maximum float64) error {
	held, set := value.Get()
	if !set || !math.IsNaN(held) && !math.IsInf(held, 0) && held >= 0 && held <= maximum {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		label+" must be a finite number from 0 to "+text.FormatNumber(maximum)+", and this request sets "+text.FormatNumber(held),
		map[string]any{"parameter": label})
}

func (ix *Index) requireScoredField(name string) error {
	shown := leadingUTF16(name, bm25DisplayedNameLength)
	field, declared := ix.settings.Schema.Field(name)
	if declared && field.IsWordIndexed() {
		return nil
	}
	if !declared {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			`BM25 parameters apply to a text field that the schema declares, and the schema declares no field "`+shown+`"`,
			map[string]any{"field": shown})
	}
	return narsilerr.New(narsilerr.CodeSearchInvalidField,
		`BM25 parameters apply to a text field alone, and the schema declares field "`+shown+`" as "`+leadingUTF16(string(field.Type), bm25DisplayedNameLength)+`"`,
		map[string]any{"field": shown})
}

func (ix *Index) validateBM25Params(params *model.BM25Params) error {
	if err := requireBM25Value("bm25.k1", params.K1, maxBM25K1); err != nil {
		return err
	}
	if err := requireBM25Value("bm25.b", params.B, maxBM25B); err != nil {
		return err
	}
	for _, name := range objectKeyOrder(params.Fields) {
		if err := ix.requireScoredField(name); err != nil {
			return err
		}
		label := "bm25.fields." + leadingUTF16(name, bm25DisplayedNameLength)
		pair := params.Fields[name]
		if err := requireBM25Value(label+".k1", pair.K1, maxBM25K1); err != nil {
			return err
		}
		if err := requireBM25Value(label+".b", pair.B, maxBM25B); err != nil {
			return err
		}
	}
	return nil
}

func (ix *Index) requireBoostableFields(boost map[string]float64) error {
	for _, field := range objectKeyOrder(boost) {
		declared, found := ix.settings.Schema.Field(field)
		if !found {
			return narsilerr.New(narsilerr.CodeSearchInvalidField,
				`The engine boosts a text field that the schema declares, and the schema declares no field "`+field+`"`,
				map[string]any{"field": field})
		}
		if !declared.IsWordIndexed() {
			return narsilerr.New(narsilerr.CodeSearchInvalidField,
				`The engine boosts a text field alone, and the schema declares field "`+field+`" as "`+string(declared.Type)+`"`,
				map[string]any{"field": field, "fieldType": string(declared.Type)})
		}
		if weight := boost[field]; math.IsNaN(weight) || math.IsInf(weight, 0) {
			return narsilerr.New(narsilerr.CodeConfigInvalid,
				`The boost on field "`+field+`" must be a finite number, and this query sets `+text.FormatNumber(weight),
				map[string]any{"field": field, "boost": text.FormatNumber(weight)})
		}
	}
	return nil
}

func undeclaredFieldOnStrictIndex(field, option string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidField,
		`The index is strict and its schema declares no field "`+field+`", so no stored document has a value in that field for this `+option,
		map[string]any{"field": field, "option": option})
}

func (ix *Index) requireGroupableFields(fields []string) error {
	for _, field := range fields {
		declared, found := ix.settings.Schema.Field(field)
		if ix.settings.Strict && !found {
			return undeclaredFieldOnStrictIndex(field, "group")
		}
		if found && declared.Base == schema.BaseVector {
			return narsilerr.New(narsilerr.CodeSearchInvalidField,
				`The engine groups hits by a text, number, boolean, enum, or geopoint field, and the schema declares field "`+field+`" as "`+string(declared.Type)+`"`,
				map[string]any{"field": field, "fieldType": string(declared.Type)})
		}
	}
	return nil
}

func (ix *Index) requireUsableQueryFields(query *model.QueryParams) error {
	if err := ix.validateBM25Params(&query.BM25); err != nil {
		return err
	}
	if query.Boost != nil {
		if err := ix.requireBoostableFields(query.Boost); err != nil {
			return err
		}
	}
	if query.Facets != nil {
		if err := facets.RequireFacetableFields(query.Facets, ix.settings.Schema, ix.settings.Strict); err != nil {
			return err
		}
	}
	if query.Group != nil && len(query.Group.Fields) > 0 {
		return ix.requireGroupableFields(query.Group.Fields)
	}
	return nil
}

func requireKnownMode(query *model.QueryParams) error {
	switch query.Mode {
	case "", model.SearchFulltext, model.SearchVector, model.SearchHybrid:
		return nil
	}
	return narsilerr.New(narsilerr.CodeSearchInvalidMode,
		`A search takes the mode "fulltext", "vector", or "hybrid", while this query names "`+string(query.Mode)+`"`,
		map[string]any{"mode": string(query.Mode), "modes": []string{"fulltext", "vector", "hybrid"}})
}

func mergeBM25Levels(search *model.BM25Params, index *model.BM25Params) *model.BM25Params {
	if !bm25SetsValue(search) {
		return index
	}
	merged := &model.BM25Params{K1: search.K1, B: search.B}
	if index != nil {
		if !merged.K1.IsSet() {
			merged.K1 = index.K1
		}
		if !merged.B.IsSet() {
			merged.B = index.B
		}
	}
	names := map[string]struct{}{}
	for name := range search.Fields {
		names[name] = struct{}{}
	}
	if index != nil {
		for name := range index.Fields {
			names[name] = struct{}{}
		}
	}
	if len(names) == 0 {
		return merged
	}
	merged.Fields = make(map[string]model.BM25FieldParams, len(names))
	for name := range names {
		fromSearch, fromIndex := search.Fields[name], model.BM25FieldParams{}
		if index != nil {
			fromIndex = index.Fields[name]
		}
		merged.Fields[name] = model.BM25FieldParams{
			K1: firstSet(fromSearch.K1, search.K1, fromIndex.K1),
			B:  firstSet(fromSearch.B, search.B, fromIndex.B),
		}
	}
	return merged
}

func firstSet(values ...model.Optional[float64]) model.Optional[float64] {
	for _, value := range values {
		if value.IsSet() {
			return value
		}
	}
	return model.Optional[float64]{}
}

func bm25SetsValue(params *model.BM25Params) bool {
	if params == nil {
		return false
	}
	if params.K1.IsSet() || params.B.IsSet() {
		return true
	}
	for _, pair := range params.Fields {
		if pair.K1.IsSet() || pair.B.IsSet() {
			return true
		}
	}
	return false
}
