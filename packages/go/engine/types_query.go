package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// SearchMode picks keyword, vector, or hybrid search for a query.
type SearchMode = model.SearchMode

const (
	// SearchFulltext ranks documents by keyword relevance.
	SearchFulltext = model.SearchFulltext
	// SearchVector ranks documents by vector similarity.
	SearchVector = model.SearchVector
	// SearchHybrid fuses a keyword ranking with a vector ranking.
	SearchHybrid = model.SearchHybrid
)

// TermMatch sets how many query terms a document must match.
type TermMatch = model.TermMatch

// MatchAllTerms returns a policy under which a document matches every query term.
func MatchAllTerms() TermMatch {
	return model.MatchAllTerms()
}

// MatchAnyTerm returns a policy under which a document matches at least one query term.
func MatchAnyTerm() TermMatch {
	return model.MatchAnyTerm()
}

// MatchTermCount returns a policy under which a document matches count query
// terms, or that fraction of them when count is below 1.
func MatchTermCount(count float64) TermMatch {
	return model.MatchTermCount(count)
}

// SortDirection picks ascending or descending order.
type SortDirection = model.SortDirection

const (
	// SortAscending puts the lowest value first.
	SortAscending = model.SortAscending
	// SortDescending puts the highest value first.
	SortDescending = model.SortDescending
)

// SortMode picks the value that a list field sorts by.
type SortMode = model.SortMode

const (
	// SortByMinimum sorts a list field by its lowest value.
	SortByMinimum = model.SortByMinimum
	// SortByMaximum sorts a list field by its highest value.
	SortByMaximum = model.SortByMaximum
	// SortByMean sorts a list field by the mean of its values.
	SortByMean = model.SortByMean
	// SortByMedian sorts a list field by the median of its values.
	SortByMedian = model.SortByMedian
)

// SortField orders results by one field.
type SortField = model.SortField

// DocumentProjection picks which fields of each document a read returns.
type DocumentProjection = model.DocumentProjection

// NoDocumentFields returns a projection under which each hit carries its ID alone.
func NoDocumentFields() DocumentProjection {
	return model.NoDocumentFields()
}

// IncludeFields returns a projection that keeps fields alone.
func IncludeFields(fields ...string) DocumentProjection {
	return model.IncludeFields(fields...)
}

// ExcludeFields returns a projection that drops fields and keeps the rest.
func ExcludeFields(fields ...string) DocumentProjection {
	return model.ExcludeFields(fields...)
}

// FacetRange is one numeric bucket of a facet, from From up to To.
type FacetRange = model.FacetRange

// FacetFieldConfig sets how many values a facet counts and how it orders them.
type FacetFieldConfig = model.FacetFieldConfig

// FacetConfig maps each faceted field to its settings.
type FacetConfig = model.FacetConfig

// GroupReducer folds the hits of each group into one value.
type GroupReducer = model.GroupReducer

// GroupConfig groups hits by the values of some fields.
type GroupConfig = model.GroupConfig

// HighlightConfig asks for marked snippets of the matching text.
type HighlightConfig = model.HighlightConfig

// PinnedDocument places one document at a fixed position in the results.
type PinnedDocument = model.PinnedDocument

// VectorQueryConfig sets the vector field, the query vector or the text to
// embed, and the similarity floor of a vector search.
type VectorQueryConfig = model.VectorQueryConfig

// HybridStrategy picks how a hybrid query fuses its two rankings.
type HybridStrategy = model.HybridStrategy

const (
	// HybridRRF fuses the rankings by reciprocal rank.
	HybridRRF = model.HybridRRF
	// HybridLinear fuses normalised scores with a weight.
	HybridLinear = model.HybridLinear
)

// HybridConfig sets the fusion of a hybrid query.
type HybridConfig = model.HybridConfig

// RerankConfig asks a registered rerank adapter to reorder the top hits.
type RerankConfig = model.RerankConfig

// QueryParams carries everything a query sets: the term, the fields, the
// filters, the ranking, the page, and what each hit carries.
type QueryParams = model.QueryParams

// SuggestParams carries the prefix that Suggest completes and how many terms it returns.
type SuggestParams = model.SuggestParams

// ListParams carries the cursor, page size, filter, sort, and projection of
// ListDocuments.
type ListParams = model.ListParams
