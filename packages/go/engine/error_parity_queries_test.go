package engine_test

import (
	"math"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	parityPhraseWordLimit   = 32
	parityPhraseCountLimit  = 32
	parityToleranceLimit    = 10
	parityPrefixLimit       = 1024
	parityCursorLimit       = 40_960
	paritySortFieldLimit    = 8
	parityFilterDepthLimit  = 30
	parityFilterTestLimit   = 1_024
	parityFilterArrayLimit  = 65_536
	parityBM25K1Limit       = 1_000
	parityHybridDepthLimit  = 10_000
	paritySuggestLimit      = 100
	parityPinnedOutOfBounds = -1
)

func paritySpaced(count int, word string) string {
	words := make([]string, count)
	for at := range words {
		words[at] = word + strconv.Itoa(at)
	}
	return strings.Join(words, " ")
}

func parityQuotedPhrases(count int) string {
	phrases := make([]string, count)
	for at := range phrases {
		phrases[at] = `"olive` + strconv.Itoa(at) + ` oil"`
	}
	return strings.Join(phrases, " ")
}

func rankEquals(value float64) map[string]any {
	return map[string]any{"fields": map[string]any{"rank": map[string]any{"eq": value}}}
}

func goRankEquals(value float64) engine.FilterExpression {
	return engine.FilterExpression{Fields: map[string]engine.FieldFilter{"rank": {Eq: engine.NumberValue(value)}}}
}

func parityDeepFilter(depth int) (map[string]any, *engine.FilterExpression) {
	ts := rankEquals(1)
	goFilter := goRankEquals(1)
	for range depth {
		ts = map[string]any{"not": ts}
		inner := goFilter
		goFilter = engine.FilterExpression{Not: &inner}
	}
	return ts, &goFilter
}

func parityWideFilter(tests int) (map[string]any, *engine.FilterExpression) {
	ts := make([]any, tests)
	goTests := make([]engine.FilterExpression, tests)
	for at := range tests {
		ts[at] = rankEquals(float64(at))
		goTests[at] = goRankEquals(float64(at))
	}
	return map[string]any{"or": ts}, &engine.FilterExpression{Or: goTests}
}

func parityLargeIn(size int) (map[string]any, *engine.FilterExpression) {
	values := make([]string, size)
	for at := range values {
		values[at] = strconv.Itoa(at)
	}
	return map[string]any{"fields": map[string]any{"title": map[string]any{"in": values}}},
		&engine.FilterExpression{Fields: map[string]engine.FieldFilter{"title": {In: values}}}
}

func paritySorts(count int) ([]any, []engine.SortField) {
	ts := make([]any, count)
	goSorts := make([]engine.SortField, count)
	for at := range count {
		ts[at] = map[string]any{"field": "rank", "direction": "asc"}
		goSorts[at] = engine.SortField{Field: "rank", Direction: engine.SortAscending}
	}
	return ts, goSorts
}

func parityVector(value []float64) *engine.VectorQueryConfig {
	vector := make([]float32, len(value))
	for at, component := range value {
		vector[at] = float32(component)
	}
	return &engine.VectorQueryConfig{Field: "embedding", Value: vector}
}

func parityQueryCases() []parityCase {
	deepTS, deepGo := parityDeepFilter(parityFilterDepthLimit + 1)
	wideTS, wideGo := parityWideFilter(parityFilterTestLimit + 1)
	inTS, inGo := parityLargeIn(parityFilterArrayLimit + 1)
	sortTS, sortGo := paritySorts(paritySortFieldLimit + 1)
	longPhrase := `"` + paritySpaced(parityPhraseWordLimit+1, "word") + `"`
	manyPhrases := parityQuotedPhrases(parityPhraseCountLimit + 1)
	hybrid := func(config map[string]any) map[string]any {
		return map[string]any{"mode": "hybrid", "term": "olive", "vector": map[string]any{"field": "embedding", "value": []any{1.0, 0.0, 0.0}},
			"hybrid": config}
	}
	goHybrid := func(config engine.HybridConfig) engine.QueryParams {
		return engine.QueryParams{Mode: engine.SearchHybrid, Term: "olive", Vector: parityVector([]float64{1, 0, 0}), Hybrid: &config}
	}
	noPositionsTS := map[string]any{"schema": tsParityBaseSchema(), "trackPositions": false}
	noPositionsGo := engine.IndexConfig{Schema: parityBaseSchema(), TrackPositions: engine.Some(false)}
	return []parityCase{
		queryCase("a phrase one word past the limit", map[string]any{"term": longPhrase}, engine.QueryParams{Term: longPhrase}),
		queryCase("one phrase past the phrase limit", map[string]any{"term": manyPhrases}, engine.QueryParams{Term: manyPhrases}),
		queryCase("a phrase on an index without positions", map[string]any{"term": `"olive oil"`},
			engine.QueryParams{Term: `"olive oil"`}).on(noPositionsTS, noPositionsGo),
		queryCase("a negative limit", map[string]any{"term": "olive", "limit": -1.0}, engine.QueryParams{Term: "olive", Limit: engine.Some(-1)}),
		queryCase("a negative offset", map[string]any{"term": "olive", "offset": -1.0}, engine.QueryParams{Term: "olive", Offset: -1}),
		queryCase("a tolerance past the limit", map[string]any{"term": "olive", "tolerance": float64(parityToleranceLimit + 1)},
			engine.QueryParams{Term: "olive", Tolerance: engine.Some(parityToleranceLimit + 1)}),
		queryCase("a negative tolerance", map[string]any{"term": "olive", "tolerance": -1.0},
			engine.QueryParams{Term: "olive", Tolerance: engine.Some(-1)}),
		queryCase("a prefix length past the limit", map[string]any{"term": "olive", "prefixLength": float64(parityPrefixLimit + 1)},
			engine.QueryParams{Term: "olive", PrefixLength: engine.Some(parityPrefixLimit + 1)}),
		queryCase("a cursor past the length limit", map[string]any{"term": "olive", "searchAfter": strings.Repeat("c", parityCursorLimit+1)},
			engine.QueryParams{Term: "olive", SearchAfter: engine.Some(strings.Repeat("c", parityCursorLimit+1))}),
		queryCase("a cursor of garbage", map[string]any{"term": "olive", "searchAfter": "not-a-cursor"},
			engine.QueryParams{Term: "olive", SearchAfter: engine.Some("not-a-cursor")}),
		queryCase("one sort field past the limit", map[string]any{"term": "olive", "sort": sortTS}, engine.QueryParams{Term: "olive", Sort: sortGo}),
		queryCase("a sort on a text field", map[string]any{"term": "olive", "sort": map[string]any{"title": "asc"}},
			engine.QueryParams{Term: "olive", Sort: []engine.SortField{{Field: "title", Direction: engine.SortAscending}}}),
		queryCase("a sort on a missing field", map[string]any{"term": "olive", "sort": map[string]any{"colour": "asc"}},
			engine.QueryParams{Term: "olive", Sort: []engine.SortField{{Field: "colour", Direction: engine.SortAscending}}}),
		queryCase("a sort in a bad direction", map[string]any{"term": "olive", "sort": map[string]any{"rank": "sideways"}},
			engine.QueryParams{Term: "olive", Sort: []engine.SortField{{Field: "rank", Direction: engine.SortDirection("sideways")}}}),
		queryCase("a filter one level past the depth limit", map[string]any{"term": "olive", "filters": deepTS},
			engine.QueryParams{Term: "olive", Filters: deepGo}),
		queryCase("a filter one test past the limit", map[string]any{"term": "olive", "filters": wideTS},
			engine.QueryParams{Term: "olive", Filters: wideGo}),
		queryCase("an in filter one value past the limit", map[string]any{"term": "olive", "filters": inTS},
			engine.QueryParams{Term: "olive", Filters: inGo}),
		queryCase("a filter on a missing field", map[string]any{"term": "olive", "filters": map[string]any{"fields": map[string]any{"colour": map[string]any{"eq": "red"}}}},
			engine.QueryParams{Term: "olive", Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"colour": {Eq: engine.TextValue("red")}}}}),
		queryCase("a text operator on a number field", map[string]any{"term": "olive", "filters": map[string]any{"fields": map[string]any{"rank": map[string]any{"startsWith": "1"}}}},
			engine.QueryParams{Term: "olive", Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"rank": {StartsWith: engine.Some("1")}}}}),
		queryCase("a NaN in a number filter", map[string]any{"term": "olive", "filters": rankEquals(math.NaN())},
			engine.QueryParams{Term: "olive", Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"rank": {Eq: engine.NumberValue(math.NaN())}}}}),
		queryCase("a search field that is not text", map[string]any{"term": "olive", "fields": []any{"rank"}},
			engine.QueryParams{Term: "olive", Fields: []string{"rank"}}),
		queryCase("a search field that is missing", map[string]any{"term": "olive", "fields": []any{"colour"}},
			engine.QueryParams{Term: "olive", Fields: []string{"colour"}}),
		queryCase("a NaN boost", map[string]any{"term": "olive", "boost": map[string]any{"title": math.NaN()}},
			engine.QueryParams{Term: "olive", Boost: map[string]float64{"title": math.NaN()}}),
		queryCase("a boost on a missing field", map[string]any{"term": "olive", "boost": map[string]any{"colour": 2.0}},
			engine.QueryParams{Term: "olive", Boost: map[string]float64{"colour": 2}}),
		queryCase("a NaN minimum score", map[string]any{"term": "olive", "minScore": math.NaN()},
			engine.QueryParams{Term: "olive", MinScore: engine.Some(math.NaN())}),
		queryCase("a k1 past the limit", map[string]any{"term": "olive", "bm25": map[string]any{"k1": float64(parityBM25K1Limit + 1)}},
			engine.QueryParams{Term: "olive", BM25: engine.BM25Params{K1: engine.Some(float64(parityBM25K1Limit + 1))}}),
		queryCase("a negative k1", map[string]any{"term": "olive", "bm25": map[string]any{"k1": -1.0}},
			engine.QueryParams{Term: "olive", BM25: engine.BM25Params{K1: engine.Some(-1.0)}}),
		queryCase("a b past one", map[string]any{"term": "olive", "bm25": map[string]any{"b": 1.5}},
			engine.QueryParams{Term: "olive", BM25: engine.BM25Params{B: engine.Some(1.5)}}),
		queryCase("a term match of zero", map[string]any{"term": "olive oil", "termMatch": 0.0},
			engine.QueryParams{Term: "olive oil", TermMatch: engine.MatchTermCount(0)}),
		queryCase("a term match of NaN", map[string]any{"term": "olive oil", "termMatch": math.NaN()},
			engine.QueryParams{Term: "olive oil", TermMatch: engine.MatchTermCount(math.NaN())}),
		queryCase("an unknown search mode", map[string]any{"term": "olive", "mode": "semantic"},
			engine.QueryParams{Term: "olive", Mode: engine.SearchMode("semantic")}),
		queryCase("a query vector one component short", map[string]any{"mode": "vector", "vector": map[string]any{"field": "embedding", "value": []any{1.0, 0.0}}},
			engine.QueryParams{Mode: engine.SearchVector, Vector: parityVector([]float64{1, 0})}),
		queryCase("a NaN inside a query vector", map[string]any{"mode": "vector", "vector": map[string]any{"field": "embedding", "value": []any{math.NaN(), 0.0, 0.0}}},
			engine.QueryParams{Mode: engine.SearchVector, Vector: parityVector([]float64{math.NaN(), 0, 0})}),
		queryCase("a vector search on a text field", map[string]any{"mode": "vector", "vector": map[string]any{"field": "title", "value": []any{1.0, 0.0, 0.0}}},
			engine.QueryParams{Mode: engine.SearchVector, Vector: &engine.VectorQueryConfig{Field: "title", Value: []float32{1, 0, 0}}}),
		queryCase("a vector search with no vector", map[string]any{"mode": "vector"}, engine.QueryParams{Mode: engine.SearchVector}),
		queryCase("a hybrid depth of zero", hybrid(map[string]any{"depth": 0.0}), goHybrid(engine.HybridConfig{Depth: engine.Some(0)})),
		queryCase("a hybrid depth past the limit", hybrid(map[string]any{"depth": float64(parityHybridDepthLimit + 1)}),
			goHybrid(engine.HybridConfig{Depth: engine.Some(parityHybridDepthLimit + 1)})),
		queryCase("a linear alpha past one", hybrid(map[string]any{"strategy": "linear", "alpha": 1.5}),
			goHybrid(engine.HybridConfig{Strategy: engine.HybridLinear, Alpha: engine.Some(1.5)})),
		queryCase("a rank constant of zero", hybrid(map[string]any{"strategy": "rrf", "k": 0.0}),
			goHybrid(engine.HybridConfig{Strategy: engine.HybridRRF, K: engine.Some(0)})),
		queryCase("an unknown fusion strategy", hybrid(map[string]any{"strategy": "borda"}),
			goHybrid(engine.HybridConfig{Strategy: engine.HybridStrategy("borda")})),
		queryCase("a sort on a hybrid search", func() map[string]any {
			query := hybrid(map[string]any{})
			query["sort"] = map[string]any{"rank": "asc"}
			return query
		}(), func() engine.QueryParams {
			query := goHybrid(engine.HybridConfig{})
			query.Sort = []engine.SortField{{Field: "rank", Direction: engine.SortAscending}}
			return query
		}()),
		queryCase("a pinned document at a negative position", map[string]any{"term": "olive", "pinned": []any{map[string]any{"docId": "two", "position": float64(parityPinnedOutOfBounds)}}},
			engine.QueryParams{Term: "olive", Pinned: []engine.PinnedDocument{{DocID: "two", Position: parityPinnedOutOfBounds}}}),
		queryCase("a facet on a missing field", map[string]any{"term": "olive", "facets": map[string]any{"colour": map[string]any{}}},
			engine.QueryParams{Term: "olive", Facets: engine.FacetConfig{"colour": {}}}),
		queryCase("a group on a missing field", map[string]any{"term": "olive", "group": map[string]any{"fields": []any{"colour"}}},
			engine.QueryParams{Term: "olive", Group: &engine.GroupConfig{Fields: []string{"colour"}}}),
		preflightCase("a preflight with a phrase past the limit", map[string]any{"term": longPhrase}, engine.QueryParams{Term: longPhrase}),
		preflightCase("a preflight with a filter past the depth limit", map[string]any{"term": "olive", "filters": deepTS},
			engine.QueryParams{Term: "olive", Filters: deepGo}),
		suggestCase("a suggestion limit past the limit", map[string]any{"prefix": "ol", "limit": float64(paritySuggestLimit + 1)},
			engine.SuggestParams{Prefix: "ol", Limit: engine.Some(paritySuggestLimit + 1)}),
		suggestCase("a suggestion limit of zero", map[string]any{"prefix": "ol", "limit": 0.0},
			engine.SuggestParams{Prefix: "ol", Limit: engine.Some(0)}),
		suggestCase("a suggestion prefix past the length limit", map[string]any{"prefix": strings.Repeat("o", parityPrefixLimit+1)},
			engine.SuggestParams{Prefix: strings.Repeat("o", parityPrefixLimit+1)}),
	}
}
