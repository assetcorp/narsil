use narsil::{
    Bm25Params, FacetSpec, GroupConfig, HybridConfig, HybridStrategy, Map, Metric, Pin,
    QueryParams, ScoringMode, SearchMode, SortDirection, SortField, TermMatch, Value, VectorQuery,
};

use crate::constants::MAX_FACET_BUCKETS;
use crate::reads::list::{direction_name, wire_sort_field};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WireGroup {
    pub(crate) fields: Vec<String>,
    pub(crate) max_per_group: usize,
    pub(crate) limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WireFacet {
    pub(crate) field: String,
    pub(crate) sort: Option<SortDirection>,
    pub(crate) ranges: Option<Vec<(f64, f64)>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WireVector {
    pub(crate) query: VectorQuery,
    pub(crate) rescore_window: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WireQuery {
    pub(crate) term: Option<String>,
    pub(crate) filters: Option<Value>,
    pub(crate) sort: Option<Vec<SortField>>,
    pub(crate) group: Option<WireGroup>,
    pub(crate) facets: Option<Vec<WireFacet>>,
    pub(crate) facet_size: Option<usize>,
    pub(crate) limit: usize,
    pub(crate) offset: usize,
    pub(crate) search_after: Option<String>,
    pub(crate) fields: Option<Vec<String>>,
    pub(crate) boost: Option<Vec<(String, f64)>>,
    pub(crate) tolerance: Option<u32>,
    pub(crate) threshold: Option<f64>,
    pub(crate) include_scores: Option<bool>,
    pub(crate) scoring: ScoringMode,
    pub(crate) term_match: Option<TermMatch>,
    pub(crate) prefix_length: Option<u32>,
    pub(crate) prefix: Option<bool>,
    pub(crate) partial_words: Option<bool>,
    pub(crate) exact: Option<bool>,
    pub(crate) pinned: Option<Vec<Pin>>,
    pub(crate) mode: Option<SearchMode>,
    pub(crate) vector: Option<WireVector>,
    pub(crate) hybrid: Option<HybridConfig>,
    pub(crate) bm25: Option<Bm25Params>,
    pub(crate) index_bm25: Option<Value>,
    pub(crate) analysis_generation: Option<u64>,
}

impl WireQuery {
    pub(crate) fn sort_fields(&self) -> Option<&[SortField]> {
        self.sort.as_deref().filter(|sort| !sort.is_empty())
    }
}

fn optional<T>(value: Option<T>, convert: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, convert)
}

fn texts(values: &[String]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|text| Value::from(text.as_str()))
            .collect(),
    )
}

fn scoring_name(scoring: ScoringMode) -> &'static str {
    match scoring {
        ScoringMode::Local => "local",
        ScoringMode::Dfs => "dfs",
        ScoringMode::Broadcast => "broadcast",
    }
}

fn mode_name(mode: SearchMode) -> &'static str {
    match mode {
        SearchMode::Fulltext => "fulltext",
        SearchMode::Vector => "vector",
        SearchMode::Hybrid => "hybrid",
    }
}

fn metric_name(metric: Metric) -> &'static str {
    match metric {
        Metric::Cosine => "cosine",
        Metric::DotProduct => "dotProduct",
        Metric::Euclidean => "euclidean",
    }
}

fn term_match_value(term_match: TermMatch) -> Value {
    match term_match {
        TermMatch::All => Value::from("all"),
        TermMatch::Any => Value::from("any"),
        TermMatch::AtLeast(count) => Value::from(count),
    }
}

fn bm25_pair(k1: Option<f64>, b: Option<f64>) -> Map {
    let mut pair = Map::with_capacity(2);
    if let Some(k1) = k1 {
        pair.insert("k1", Value::Number(k1));
    }
    if let Some(b) = b {
        pair.insert("b", Value::Number(b));
    }
    pair
}

pub(crate) fn bm25_value(bm25: &Bm25Params) -> Value {
    let mut value = bm25_pair(bm25.k1, bm25.b);
    if let Some(fields) = &bm25.fields {
        let mut named = Map::with_capacity(fields.len());
        for (field, pair) in fields {
            named.insert(field.as_str(), Value::Object(bm25_pair(pair.k1, pair.b)));
        }
        value.insert("fields", Value::Object(named));
    }
    Value::Object(value)
}

fn group_value(group: &WireGroup) -> Value {
    let mut value = Map::with_capacity(3);
    value.insert("fields", texts(&group.fields));
    value.insert("maxPerGroup", Value::from(group.max_per_group));
    value.insert("limit", optional(group.limit, Value::from));
    Value::Object(value)
}

fn facet_value(facet: &WireFacet) -> Value {
    let mut value = Map::with_capacity(3);
    value.insert("field", Value::from(facet.field.as_str()));
    value.insert(
        "sort",
        optional(facet.sort, |sort| Value::from(direction_name(sort))),
    );
    let ranges = facet.ranges.as_ref().map(|ranges| {
        Value::Array(
            ranges
                .iter()
                .map(|(from, to)| {
                    let mut range = Map::with_capacity(2);
                    range.insert("from", Value::Number(*from));
                    range.insert("to", Value::Number(*to));
                    Value::Object(range)
                })
                .collect(),
        )
    });
    value.insert("ranges", ranges.unwrap_or(Value::Null));
    Value::Object(value)
}

fn vector_value(vector: &WireVector) -> Value {
    let query = &vector.query;
    let mut value = Map::with_capacity(8);
    value.insert("field", Value::from(query.field.as_str()));
    value.insert(
        "value",
        optional(query.value.as_ref(), |components| {
            Value::Array(
                components
                    .iter()
                    .map(|component| Value::Number(f64::from(*component)))
                    .collect(),
            )
        }),
    );
    value.insert("text", optional(query.text.as_deref(), Value::from));
    value.insert("similarity", optional(query.similarity, Value::Number));
    value.insert(
        "metric",
        optional(query.metric, |metric| Value::from(metric_name(metric))),
    );
    value.insert("efSearch", optional(query.ef_search, Value::from));
    value.insert("oversample", optional(query.oversample, Value::Number));
    value.insert(
        "rescoreWindow",
        optional(vector.rescore_window, Value::from),
    );
    Value::Object(value)
}

fn hybrid_value(hybrid: &HybridConfig) -> Value {
    let mut value = Map::with_capacity(4);
    let strategy = hybrid.strategy.map(|strategy| match strategy {
        HybridStrategy::Rrf => "rrf",
        HybridStrategy::Linear => "linear",
    });
    value.insert("strategy", optional(strategy, Value::from));
    value.insert("k", optional(hybrid.k, Value::Number));
    value.insert("alpha", optional(hybrid.alpha, Value::Number));
    value.insert("depth", optional(hybrid.depth, Value::from));
    Value::Object(value)
}

fn boost_value(boost: &[(String, f64)]) -> Value {
    let mut value = Map::with_capacity(boost.len());
    for (field, multiplier) in boost {
        value.insert(field.as_str(), Value::Number(*multiplier));
    }
    Value::Object(value)
}

fn pins_value(pinned: &[Pin]) -> Value {
    Value::Array(
        pinned
            .iter()
            .map(|pin| {
                let mut entry = Map::with_capacity(2);
                entry.insert("docId", Value::from(pin.doc_id.as_str()));
                entry.insert("position", Value::from(pin.position));
                Value::Object(entry)
            })
            .collect(),
    )
}

impl WireQuery {
    pub(crate) fn to_value(&self) -> Value {
        let mut wire = Map::with_capacity(30);
        wire.insert("term", optional(self.term.as_deref(), Value::from));
        wire.insert("filters", self.filters.clone().unwrap_or(Value::Null));
        wire.insert(
            "sort",
            optional(self.sort.as_ref(), |sort| {
                Value::Array(sort.iter().map(wire_sort_field).collect())
            }),
        );
        wire.insert("group", optional(self.group.as_ref(), group_value));
        wire.insert(
            "facets",
            optional(self.facets.as_ref(), |facets| {
                Value::Array(facets.iter().map(facet_value).collect())
            }),
        );
        wire.insert("facetSize", optional(self.facet_size, Value::from));
        wire.insert("limit", Value::from(self.limit));
        wire.insert("offset", Value::from(self.offset));
        wire.insert(
            "searchAfter",
            optional(self.search_after.as_deref(), Value::from),
        );
        wire.insert("fields", optional(self.fields.as_deref(), texts));
        wire.insert("boost", optional(self.boost.as_deref(), boost_value));
        wire.insert("tolerance", optional(self.tolerance, Value::from));
        wire.insert("threshold", optional(self.threshold, Value::Number));
        wire.insert("includeScores", optional(self.include_scores, Value::Bool));
        wire.insert("scoring", Value::from(scoring_name(self.scoring)));
        wire.insert("termMatch", optional(self.term_match, term_match_value));
        wire.insert("prefixLength", optional(self.prefix_length, Value::from));
        wire.insert("prefix", optional(self.prefix, Value::Bool));
        wire.insert("partialWords", optional(self.partial_words, Value::Bool));
        wire.insert("exact", optional(self.exact, Value::Bool));
        wire.insert("pinned", optional(self.pinned.as_deref(), pins_value));
        wire.insert(
            "mode",
            optional(self.mode, |mode| Value::from(mode_name(mode))),
        );
        wire.insert("vector", optional(self.vector.as_ref(), vector_value));
        wire.insert("hybrid", optional(self.hybrid.as_ref(), hybrid_value));
        if let Some(bm25) = &self.bm25 {
            wire.insert("bm25", bm25_value(bm25));
        }
        if let Some(index_bm25) = &self.index_bm25 {
            wire.insert("indexBm25", index_bm25.clone());
        }
        if let Some(generation) = self.analysis_generation {
            wire.insert("analysisGeneration", Value::from(generation));
        }
        Value::Object(wire)
    }

    pub(crate) fn to_local(&self) -> QueryParams {
        let facet_limit = self.facet_size;
        QueryParams {
            term: self.term.clone(),
            fields: self.fields.clone(),
            filters: self.filters.clone(),
            boost: self.boost.clone(),
            bm25: self.bm25.clone(),
            scoring: Some(self.scoring),
            tolerance: self.tolerance,
            min_score: self.threshold,
            include_scores: self.include_scores,
            term_match: self.term_match,
            prefix_length: self.prefix_length,
            prefix: self.prefix,
            partial_words: self.partial_words,
            exact: self.exact,
            pinned: self.pinned.clone(),
            mode: self.mode,
            limit: Some(self.limit),
            offset: Some(self.offset),
            search_after: self.search_after.clone(),
            sort: self.sort_fields().map(<[SortField]>::to_vec),
            group: self.group.as_ref().map(|group| GroupConfig {
                fields: group.fields.clone(),
                max_per_group: Some(group.max_per_group),
                limit: group.limit,
                reduce: None,
            }),
            facets: self
                .facets
                .as_ref()
                .filter(|facets| !facets.is_empty())
                .map(|facets| local_facets(facets, facet_limit)),
            vector: self.vector.as_ref().map(|vector| vector.query.clone()),
            hybrid: self.hybrid,
            ..QueryParams::default()
        }
    }
}

fn local_facets(facets: &[WireFacet], limit: Option<usize>) -> Vec<(String, FacetSpec)> {
    let mut specs: Vec<(String, FacetSpec)> = Vec::with_capacity(facets.len());
    for facet in facets {
        let counts_every_value = facet.ranges.is_some() || facet.sort == Some(SortDirection::Asc);
        let spec = FacetSpec {
            limit: match counts_every_value {
                true => Some(MAX_FACET_BUCKETS),
                false => limit,
            },
            sort: facet.sort,
            ranges: facet.ranges.clone(),
        };
        match specs.iter_mut().find(|(field, _)| *field == facet.field) {
            Some(held) => held.1 = spec,
            None => specs.push((facet.field.clone(), spec)),
        }
    }
    specs
}
