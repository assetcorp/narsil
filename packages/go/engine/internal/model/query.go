package model

type SearchMode string

const (
	SearchFulltext SearchMode = "fulltext"
	SearchVector   SearchMode = "vector"
	SearchHybrid   SearchMode = "hybrid"
)

type TermMatchKind uint8

const (
	TermMatchAbsent TermMatchKind = iota
	TermMatchAll
	TermMatchAny
	TermMatchCount
)

type TermMatch struct {
	kind  TermMatchKind
	count float64
}

func MatchAllTerms() TermMatch {
	return TermMatch{kind: TermMatchAll}
}

func MatchAnyTerm() TermMatch {
	return TermMatch{kind: TermMatchAny}
}

func MatchTermCount(count float64) TermMatch {
	return TermMatch{kind: TermMatchCount, count: count}
}

func (t TermMatch) Kind() TermMatchKind {
	return t.kind
}

func (t TermMatch) Count() (float64, bool) {
	return t.count, t.kind == TermMatchCount
}

type SortDirection string

const (
	SortAscending  SortDirection = "asc"
	SortDescending SortDirection = "desc"
)

type SortMode string

const (
	SortByMinimum SortMode = "min"
	SortByMaximum SortMode = "max"
	SortByMean    SortMode = "avg"
	SortByMedian  SortMode = "median"
)

type SortField struct {
	Field     string
	Direction SortDirection
	Mode      SortMode
}

type DocumentProjectionKind uint8

const (
	ProjectWholeDocument DocumentProjectionKind = iota
	ProjectNoFields
	ProjectSelectedFields
)

type DocumentProjection struct {
	kind    DocumentProjectionKind
	include Optional[[]string]
	exclude []string
}

func NoDocumentFields() DocumentProjection {
	return DocumentProjection{kind: ProjectNoFields}
}

func IncludeFields(fields ...string) DocumentProjection {
	return DocumentProjection{kind: ProjectSelectedFields, include: Some(append([]string{}, fields...))}
}

func ExcludeFields(fields ...string) DocumentProjection {
	return DocumentProjection{kind: ProjectSelectedFields, exclude: append([]string{}, fields...)}
}

func (p DocumentProjection) Excluding(fields ...string) DocumentProjection {
	if p.kind == ProjectNoFields {
		return p
	}
	excluded := append(append([]string{}, p.exclude...), fields...)
	return DocumentProjection{kind: ProjectSelectedFields, include: p.include, exclude: excluded}
}

func (p DocumentProjection) Kind() DocumentProjectionKind {
	return p.kind
}

func (p DocumentProjection) Include() ([]string, bool) {
	fields, set := p.include.Get()
	return append([]string(nil), fields...), set
}

func (p DocumentProjection) Exclude() []string {
	return append([]string(nil), p.exclude...)
}

type FacetRange struct {
	From float64
	To   float64
}

type FacetFieldConfig struct {
	Limit  Optional[int]
	Sort   SortDirection
	Ranges []FacetRange
}

type FacetConfig map[string]FacetFieldConfig

type GroupReducer struct {
	Reduce       func(accumulator any, document Document, score float64) (any, error)
	InitialValue func() any
}

type GroupConfig struct {
	Fields      []string
	MaxPerGroup Optional[int]
	Limit       Optional[int]
	Reduce      *GroupReducer
}

type HighlightConfig struct {
	Fields           []string
	PreTag           Optional[string]
	PostTag          Optional[string]
	MaxSnippetLength Optional[int]
}

type PinnedDocument struct {
	DocID    string
	Position int
}

type VectorQueryConfig struct {
	Field      string
	Value      []float32
	Text       Optional[string]
	Similarity Optional[float64]
	Metric     VectorMetric
	EfSearch   Optional[int]
	Oversample Optional[float64]
}

type HybridStrategy string

const (
	HybridRRF    HybridStrategy = "rrf"
	HybridLinear HybridStrategy = "linear"
)

type HybridConfig struct {
	Strategy HybridStrategy
	K        Optional[int]
	Alpha    Optional[float64]
	Depth    Optional[int]
}

type RerankConfig struct {
	Adapter string
	Fields  []string
	Query   Optional[string]
	Window  Optional[int]
}

type QueryParams struct {
	Term                   string
	Fields                 []string
	Filters                *FilterExpression
	Boost                  map[string]float64
	BM25                   BM25Params
	Scoring                ScoringMode
	MinScore               Optional[float64]
	TermMatch              TermMatch
	Tolerance              Optional[int]
	PrefixLength           Optional[int]
	Prefix                 bool
	PartialWords           bool
	Exact                  bool
	Facets                 FacetConfig
	Sort                   []SortField
	Group                  *GroupConfig
	Limit                  Optional[int]
	Offset                 int
	SearchAfter            Optional[string]
	Highlight              *HighlightConfig
	Pinned                 []PinnedDocument
	Mode                   SearchMode
	Vector                 *VectorQueryConfig
	Hybrid                 *HybridConfig
	Rerank                 *RerankConfig
	IncludeScores          bool
	IncludeScoreComponents bool
	Document               DocumentProjection
}

type SuggestParams struct {
	Prefix string
	Limit  Optional[int]
}

type ListParams struct {
	Cursor   Optional[string]
	Limit    Optional[int]
	Filters  *FilterExpression
	Sort     []SortField
	Document DocumentProjection
}
