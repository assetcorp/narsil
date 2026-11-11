use std::collections::BTreeMap;
use std::time::Duration;

use crate::value::{Map, Value};

/// The numbers that BM25 combined into one hit's score.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScoreComponents {
    /// How often each query term occurs in each field, keyed as `field:term`.
    pub term_frequencies: BTreeMap<String, f64>,
    /// The length of each field that the query searched, keyed by field.
    pub field_lengths: BTreeMap<String, f64>,
    /// The inverse document frequency of each query term, keyed by term.
    pub idf: BTreeMap<String, f64>,
}

/// One match inside a highlighted field, as offsets into the field's text counted in UTF-16 code units, the unit
/// that every Narsil implementation counts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HighlightPosition {
    /// The offset where the match starts.
    pub start: usize,
    /// The offset just past the end of the match.
    pub end: usize,
}

/// A highlighted field, ready to render.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HighlightMatch {
    /// The field's text around the matches, with each match wrapped in the query's tags.
    pub snippet: String,
    /// The matches that the snippet shows.
    pub positions: Vec<HighlightPosition>,
}

/// One document that a query returned.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hit {
    /// The ID that the document is stored under.
    pub id: String,
    /// The score that ranked the hit, or `None` for a sorted query that did not ask for scores.
    pub score: Option<f64>,
    /// The stored document, as the query's projection shapes it.
    pub document: Map,
    /// The parts of the score, where the query asked for them.
    pub score_components: Option<ScoreComponents>,
    /// The highlighted fields, where the query asked for them.
    pub highlights: Option<BTreeMap<String, HighlightMatch>>,
}

/// The counts of one facet field.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FacetResult {
    /// The number of matching documents per value, in the facet's order.
    pub values: Vec<(String, u64)>,
    /// The number of entries in `values`.
    pub count: usize,
    /// How far below its true count any value's count can be, where 0 means every count is exact.
    pub error_bound: u64,
}

/// One group of a grouped query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GroupResult {
    /// The value of each grouping field, keyed by field in the order that the query lists them, where `None` means
    /// that the group's documents hold no value at that path.
    pub values: Vec<(String, Option<Value>)>,
    /// The group's hits.
    pub hits: Vec<Hit>,
    /// The value of the query's reducer, where it set one.
    pub reduced: Option<Value>,
    /// The reducer's error, where it failed.
    pub reducer_error: Option<String>,
}

/// How many partitions a query reached.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueryCoverage {
    /// The partitions that the index holds.
    pub total_partitions: usize,
    /// The partitions that the query searched.
    pub queried_partitions: usize,
    /// The partitions that ran out of time.
    pub timed_out_partitions: usize,
    /// The partitions that failed.
    pub failed_partitions: usize,
}

/// What a query returns.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryResult {
    /// The page of hits.
    pub hits: Vec<Hit>,
    /// The number of documents that matched.
    pub count: u64,
    /// Whether `count` is exact.
    pub count_exact: bool,
    /// How long the query took.
    pub elapsed: Duration,
    /// The cursor of the next page, where one follows.
    pub cursor: Option<String>,
    /// The facet counts, in the order that the query listed the fields.
    pub facets: Option<Vec<(String, FacetResult)>>,
    /// The groups of a grouped query.
    pub groups: Option<Vec<GroupResult>>,
    /// Whether the index's analysis changed since the documents that the query matched were indexed.
    pub analysis_stale: bool,
    /// How many partitions the query reached.
    pub coverage: QueryCoverage,
}
