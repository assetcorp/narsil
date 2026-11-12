use std::fmt;
use std::sync::Arc;

use crate::config::{Bm25Params, Metric, ScoringMode};
use crate::value::{Map, Value};

/// Which kind of search a query runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    /// Full-text search over the text fields.
    Fulltext,
    /// Nearest-neighbour search over one vector field.
    Vector,
    /// Full-text and vector search, fused into one ranking.
    Hybrid,
}

/// How many of the query's terms a document must hold to match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermMatch {
    /// Every term.
    All,
    /// At least one term, which is the default.
    Any,
    /// At least this many terms.
    AtLeast(u32),
}

/// The order of a sort key or a facet's values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    /// Lowest first.
    Asc,
    /// Highest first.
    Desc,
}

/// Which value of a list field a sort compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortMode {
    /// The lowest value.
    Min,
    /// The highest value.
    Max,
    /// The mean of the values.
    Avg,
    /// The median of the values.
    Median,
}

/// One key of a sort, in priority order.
#[derive(Debug, Clone, PartialEq)]
pub struct SortField {
    /// The field path to sort by.
    pub field: String,
    /// The direction of the sort.
    pub direction: SortDirection,
    /// Which value of a list field to compare, or `None` for the default of the field's type.
    pub mode: Option<SortMode>,
}

/// The counts that a query asks for on one field.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FacetSpec {
    /// The most values to return, or `None` for the engine's default.
    pub limit: Option<usize>,
    /// The order of the values by count, or `None` for most first.
    pub sort: Option<SortDirection>,
    /// Numeric ranges to count, each from a lower to an upper bound, in place of distinct values.
    pub ranges: Option<Vec<(f64, f64)>>,
}

/// A function that folds each hit of a group into one value.
///
/// When the function returns an error, or when it or the initial value panics, the group holds the text of that
/// error or panic in `reducer_error` and leaves `reduced` empty.
pub type GroupReduce = Arc<dyn Fn(Value, &Map, f64) -> Result<Value, String> + Send + Sync>;

/// The fold that a grouped query applies to each group's hits.
#[derive(Clone)]
pub struct GroupReducer {
    /// Folds one hit's document and score into the accumulator.
    pub reducer: GroupReduce,
    /// Returns the first value of the accumulator.
    pub initial_value: Arc<dyn Fn() -> Value + Send + Sync>,
}

impl fmt::Debug for GroupReducer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GroupReducer")
    }
}

/// How a query groups its hits by field values.
#[derive(Debug, Clone, Default)]
pub struct GroupConfig {
    /// The field paths whose values form a group's key.
    pub fields: Vec<String>,
    /// The most hits that each group keeps.
    pub max_per_group: Option<usize>,
    /// The most groups to return.
    pub limit: Option<usize>,
    /// The fold to apply to each group's hits.
    pub reduce: Option<GroupReducer>,
}

/// The fields whose matches a query wraps in tags.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HighlightConfig {
    /// The field paths to highlight.
    pub fields: Vec<String>,
    /// The tag before each match, `<mark>` by default.
    pub pre_tag: Option<String>,
    /// The tag after each match, `</mark>` by default.
    pub post_tag: Option<String>,
    /// The longest snippet, in UTF-16 code units, 200 by default, where 0 keeps the whole text.
    pub max_snippet_length: Option<usize>,
}

/// A document that a query places at a fixed position of its results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    /// The ID of the document.
    pub doc_id: String,
    /// The position from zero at which the document appears.
    pub position: usize,
}

/// Which parts of each stored document a hit carries.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum DocumentProjection {
    /// The whole document, which is the default.
    #[default]
    All,
    /// No document at all.
    None,
    /// The fields that `include` lists, less those that `exclude` lists.
    Fields {
        /// The field paths to keep, or `None` for every field.
        include: Option<Vec<String>>,
        /// The field paths to leave out.
        exclude: Option<Vec<String>>,
    },
}

/// The vector clause of a vector or hybrid query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VectorQuery {
    /// The vector field to search.
    pub field: String,
    /// The query vector.
    pub value: Option<Vec<f32>>,
    /// Text that the index's embedding adapter turns into the query vector.
    pub text: Option<String>,
    /// The lowest similarity that a hit may have.
    pub similarity: Option<f64>,
    /// The metric that scores each hit, or `None` for cosine similarity.
    pub metric: Option<Metric>,
    /// The candidate list size of the graph search.
    pub ef_search: Option<u32>,
    /// How many more candidates than requested a quantised search rescores.
    pub oversample: Option<f64>,
}

/// How a hybrid query fuses its full-text and vector rankings.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum HybridStrategy {
    /// Reciprocal rank fusion, which is the default.
    #[default]
    Rrf,
    /// A weighted sum of normalised scores.
    Linear,
}

/// The fusion settings of a hybrid query.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HybridConfig {
    /// How the rankings fuse.
    pub strategy: Option<HybridStrategy>,
    /// The rank constant of reciprocal rank fusion.
    pub k: Option<f64>,
    /// The weight of the vector ranking in linear fusion, from 0 to 1.
    pub alpha: Option<f64>,
    /// How deep each ranking goes before fusion.
    pub depth: Option<usize>,
}

/// The rerank step of a query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RerankConfig {
    /// The name of a registered rerank adapter.
    pub adapter: String,
    /// The fields whose text the adapter reads.
    pub fields: Vec<String>,
    /// The text that the adapter compares the documents with, or `None` for the query's term.
    pub query: Option<String>,
    /// How many of the best hits the adapter reranks.
    pub window: Option<usize>,
}

/// Everything that a query can ask for. Every field is optional, and [`Default`] gives a query that matches
/// nothing until it sets a term or a vector.
#[derive(Debug, Clone, Default)]
pub struct QueryParams {
    /// The text to search for, where a quoted part is a phrase.
    pub term: Option<String>,
    /// The text fields to search, or `None` for every text field.
    pub fields: Option<Vec<String>>,
    /// A filter expression, in the same shape as the JSON filters of every Narsil implementation; build one with
    /// [`crate::Filter`] and convert it with `Value::from`. The hits and the count then cover the documents that the
    /// filter accepts alone.
    pub filters: Option<Value>,
    /// A multiplier per field, in the order given.
    pub boost: Option<Vec<(String, f64)>>,
    /// BM25 parameters for this query alone.
    pub bm25: Option<Bm25Params>,
    /// How the query gathers BM25 statistics across partitions.
    pub scoring: Option<ScoringMode>,
    /// The lowest score that a hit may have.
    pub min_score: Option<f64>,
    /// How many terms a document must hold.
    pub term_match: Option<TermMatch>,
    /// How many typos a term may have, from 0 to 2.
    pub tolerance: Option<u32>,
    /// How many leading characters a typo match must share with the term.
    pub prefix_length: Option<u32>,
    /// Whether the last term also matches the words that start with it.
    pub prefix: Option<bool>,
    /// Whether a term also matches inside the words of a partial-word field.
    pub partial_words: Option<bool>,
    /// Whether the terms match only as written, without typos, synonyms, or prefixes.
    pub exact: Option<bool>,
    /// The fields to count values on, in the order given.
    pub facets: Option<Vec<(String, FacetSpec)>>,
    /// The sort keys, in priority order.
    pub sort: Option<Vec<SortField>>,
    /// How to group the hits.
    pub group: Option<GroupConfig>,
    /// The most hits to return, 10 by default.
    pub limit: Option<usize>,
    /// How many hits to skip.
    pub offset: Option<usize>,
    /// The cursor of an earlier page, to return the page after it.
    pub search_after: Option<String>,
    /// The fields to highlight.
    pub highlight: Option<HighlightConfig>,
    /// Documents at fixed positions.
    pub pinned: Option<Vec<Pin>>,
    /// The kind of search, or `None` to infer it from the term and the vector.
    pub mode: Option<SearchMode>,
    /// The vector clause.
    pub vector: Option<VectorQuery>,
    /// The fusion settings of a hybrid query.
    pub hybrid: Option<HybridConfig>,
    /// The rerank step.
    pub rerank: Option<RerankConfig>,
    /// Whether a sorted query still reports each hit's score.
    pub include_scores: Option<bool>,
    /// Whether each hit carries the parts that its score was built from.
    pub include_score_components: Option<bool>,
    /// Which parts of each document the hits carry.
    pub document: Option<DocumentProjection>,
}
