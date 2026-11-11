use narsil::{
    Bm25FieldParams, Bm25Params, DocumentProjection, ErrorCode, FacetSpec, GroupConfig,
    HighlightConfig, HybridConfig, HybridStrategy, Metric, NarsilError, Pin, QueryParams,
    RerankConfig, ScoringMode, SearchMode, SortDirection, SortField, SortMode, TermMatch, Value,
    VectorQuery,
};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyString};

use super::fields::{Fields, choice_of, floats_of, items_of, number_of, string_of, whole_of};
use super::value::{ValueSource, to_value};
use crate::callbacks::reducer::group_reducer;
use crate::errors::{config_invalid, recoded};

pub(crate) const SCORING_MODES: [(&str, ScoringMode); 3] = [
    ("local", ScoringMode::Local),
    ("dfs", ScoringMode::Dfs),
    ("broadcast", ScoringMode::Broadcast),
];
pub(crate) const METRICS: [(&str, Metric); 3] = [
    ("cosine", Metric::Cosine),
    ("dotProduct", Metric::DotProduct),
    ("euclidean", Metric::Euclidean),
];
pub(crate) const DIRECTIONS: [(&str, SortDirection); 2] =
    [("asc", SortDirection::Asc), ("desc", SortDirection::Desc)];
pub(crate) const SORT_MODES: [(&str, SortMode); 4] = [
    ("min", SortMode::Min),
    ("max", SortMode::Max),
    ("avg", SortMode::Avg),
    ("median", SortMode::Median),
];
pub(crate) const SEARCH_MODES: [(&str, SearchMode); 3] = [
    ("fulltext", SearchMode::Fulltext),
    ("vector", SearchMode::Vector),
    ("hybrid", SearchMode::Hybrid),
];
pub(crate) const HYBRID_STRATEGIES: [(&str, HybridStrategy); 2] = [
    ("rrf", HybridStrategy::Rrf),
    ("linear", HybridStrategy::Linear),
];

fn bm25_pair(fields: &mut Fields<'_>) -> Result<Bm25FieldParams, NarsilError> {
    Ok(Bm25FieldParams {
        k1: fields.number("k1")?,
        b: fields.number("b")?,
    })
}

pub(crate) fn bm25_params(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<Bm25Params, NarsilError> {
    let mut fields = Fields::of(value, label)?;
    let pair = bm25_pair(&mut fields)?;
    let per_field = match fields.fields("fields")? {
        None => None,
        Some(named) => {
            let mut parsed = Vec::new();
            for (name, entry) in named.entries() {
                let name = string_of(&name, &format!("{label}.fields key"))?;
                let mut entry = Fields::of(&entry, &format!("{label}.fields.{name}"))?;
                parsed.push((name, bm25_pair(&mut entry)?));
                entry.finish()?;
            }
            Some(parsed)
        }
    };
    fields.finish()?;
    Ok(Bm25Params {
        k1: pair.k1,
        b: pair.b,
        fields: per_field,
    })
}

fn term_match(value: &Bound<'_, PyAny>, path: &str) -> Result<TermMatch, NarsilError> {
    if let Ok(text) = value.cast::<PyString>() {
        return match text.to_str() {
            Ok("all") => Ok(TermMatch::All),
            Ok("any") => Ok(TermMatch::Any),
            _ => Err(config_invalid(format!(
                "{path} must be \"all\", \"any\", or a whole number"
            ))),
        };
    }
    let count = whole_of(value, path)?;
    u32::try_from(count)
        .map(TermMatch::AtLeast)
        .map_err(|_| config_invalid(format!("{path} must be at most {}", u32::MAX)))
}

fn facets(fields: Fields<'_>, label: &str) -> Result<Vec<(String, FacetSpec)>, NarsilError> {
    let mut parsed = Vec::new();
    for (field, spec) in fields.entries() {
        let field = string_of(&field, &format!("{label} key"))?;
        let path = format!("{label}.{field}");
        let mut spec = Fields::of(&spec, &path)?;
        let ranges = match spec.get("ranges")? {
            None => None,
            Some(ranges) => {
                let mut bounds = Vec::new();
                for (at, range) in items_of(&ranges, &format!("{path}.ranges"))?
                    .iter()
                    .enumerate()
                {
                    let mut range = Fields::of(range, &format!("{path}.ranges[{at}]"))?;
                    let from = range.number("from")?;
                    let to = range.number("to")?;
                    range.finish()?;
                    match (from, to) {
                        (Some(from), Some(to)) => bounds.push((from, to)),
                        _ => {
                            return Err(config_invalid(format!(
                                "{path}.ranges[{at}] must hold \"from\" and \"to\""
                            )));
                        }
                    }
                }
                Some(bounds)
            }
        };
        let facet = FacetSpec {
            limit: spec.size("limit")?,
            sort: spec.choice("sort", &DIRECTIONS)?,
            ranges,
        };
        spec.finish()?;
        parsed.push((field, facet));
    }
    Ok(parsed)
}

fn sort_fields(value: &Bound<'_, PyAny>, label: &str) -> Result<Vec<SortField>, NarsilError> {
    if let Ok(fields) = Fields::of(value, label) {
        let mut parsed = Vec::new();
        for (field, direction) in fields.entries() {
            let field = string_of(&field, &format!("{label} key"))?;
            let direction = string_of(&direction, &format!("{label}.{field}"))?;
            parsed.push(SortField {
                direction: choice_of(&direction, &format!("{label}.{field}"), &DIRECTIONS)?,
                field,
                mode: None,
            });
        }
        return Ok(parsed);
    }
    let mut parsed = Vec::new();
    for (at, entry) in items_of(value, label)?.iter().enumerate() {
        let mut entry = Fields::of(entry, &format!("{label}[{at}]"))?;
        let field = entry.required_string("field")?;
        let direction = entry
            .choice("direction", &DIRECTIONS)?
            .ok_or_else(|| config_invalid(format!("{label}[{at}].direction is required")))?;
        let mode = entry.choice("mode", &SORT_MODES)?;
        entry.finish()?;
        parsed.push(SortField {
            field,
            direction,
            mode,
        });
    }
    Ok(parsed)
}

fn group(mut fields: Fields<'_>, label: &str) -> Result<GroupConfig, NarsilError> {
    let config = GroupConfig {
        fields: fields
            .strings("fields")?
            .ok_or_else(|| config_invalid(format!("{label}.fields is required")))?,
        max_per_group: fields.size("maxPerGroup")?,
        limit: fields.size("limit")?,
        reduce: fields
            .get("reduce")?
            .map(|reduce| group_reducer(&reduce, &format!("{label}.reduce")))
            .transpose()?,
    };
    fields.finish()?;
    Ok(config)
}

fn highlight(mut fields: Fields<'_>, label: &str) -> Result<HighlightConfig, NarsilError> {
    let config = HighlightConfig {
        fields: fields
            .strings("fields")?
            .ok_or_else(|| config_invalid(format!("{label}.fields is required")))?,
        pre_tag: fields.string("preTag")?,
        post_tag: fields.string("postTag")?,
        max_snippet_length: fields.size("maxSnippetLength")?,
    };
    fields.finish()?;
    Ok(config)
}

fn pins(value: &Bound<'_, PyAny>, label: &str) -> Result<Vec<Pin>, NarsilError> {
    let mut parsed = Vec::new();
    for (at, entry) in items_of(value, label)?.iter().enumerate() {
        let path = format!("{label}[{at}]");
        let mut entry = Fields::of(entry, &path)?;
        let doc_id = entry.required_string("docId")?;
        let position = entry
            .size("position")?
            .ok_or_else(|| config_invalid(format!("{path}.position is required")))?;
        entry.finish()?;
        parsed.push(Pin { doc_id, position });
    }
    Ok(parsed)
}

fn vector(mut fields: Fields<'_>) -> Result<VectorQuery, NarsilError> {
    let field = fields
        .string("field")
        .map_err(recoded(ErrorCode::SEARCH_INVALID_FIELD))?
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::SEARCH_INVALID_MODE,
                format!("{} is required", fields.path("field")),
            )
        })?;
    let path = fields.path("value");
    let value = fields
        .get("value")?
        .map(|value| floats_of(&value, &path))
        .transpose()
        .map_err(recoded(ErrorCode::DOC_VALIDATION_FAILED))?;
    let query = VectorQuery {
        field,
        value,
        text: fields.string("text")?,
        similarity: fields.number("similarity")?,
        metric: fields.choice("metric", &METRICS)?,
        ef_search: fields.whole_u32("efSearch")?,
        oversample: fields.number("oversample")?,
    };
    fields.finish()?;
    Ok(query)
}

fn hybrid(mut fields: Fields<'_>) -> Result<HybridConfig, NarsilError> {
    let config = HybridConfig {
        strategy: fields.choice("strategy", &HYBRID_STRATEGIES)?,
        k: fields.number("k")?,
        alpha: fields.number("alpha")?,
        depth: fields.size("depth")?,
    };
    fields.finish()?;
    Ok(config)
}

fn rerank(mut fields: Fields<'_>, label: &str) -> Result<RerankConfig, NarsilError> {
    let refused = recoded(ErrorCode::RERANK_CONFIG_INVALID);
    let config = RerankConfig {
        adapter: fields.required_string("adapter").map_err(&refused)?,
        fields: fields.strings("fields").map_err(&refused)?.ok_or_else(|| {
            NarsilError::new(
                ErrorCode::RERANK_CONFIG_INVALID,
                format!("{label}.fields is required"),
            )
        })?,
        query: fields.string("query").map_err(&refused)?,
        window: fields.size("window").map_err(&refused)?,
    };
    fields.finish()?;
    Ok(config)
}

pub(crate) fn projection(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<DocumentProjection, NarsilError> {
    if let Ok(flag) = value.cast::<PyBool>() {
        return Ok(if flag.is_true() {
            DocumentProjection::All
        } else {
            DocumentProjection::None
        });
    }
    let mut fields = Fields::of(value, label)?;
    let projection = DocumentProjection::Fields {
        include: fields.strings("include")?,
        exclude: fields.strings("exclude")?,
    };
    fields.finish()?;
    Ok(projection)
}

pub(crate) fn filter_value(fields: &mut Fields<'_>) -> Result<Option<Value>, NarsilError> {
    let path = fields.path("filters");
    fields
        .get("filters")?
        .map(|filters| {
            to_value(
                &filters,
                ValueSource {
                    code: ErrorCode::SEARCH_INVALID_FILTER,
                    subject: &path,
                },
            )
        })
        .transpose()
}

pub(crate) fn query_params(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<QueryParams, NarsilError> {
    let mut fields = Fields::of(value, label)?;
    let boost = match fields.fields("boost")? {
        None => None,
        Some(boosts) => {
            let mut parsed = Vec::new();
            for (field, multiplier) in boosts.entries() {
                let field = string_of(&field, &format!("{label}.boost key"))?;
                let multiplier = number_of(&multiplier, &format!("{label}.boost.{field}"))?;
                parsed.push((field, multiplier));
            }
            Some(parsed)
        }
    };
    let term_match_path = fields.path("termMatch");
    let sort_path = fields.path("sort");
    let pinned_path = fields.path("pinned");
    let document_path = fields.path("document");
    let facets_path = fields.path("facets");
    let group_path = fields.path("group");
    let highlight_path = fields.path("highlight");
    let rerank_path = fields.path("rerank");
    let bm25_path = fields.path("bm25");
    let params = QueryParams {
        term: fields.string("term")?,
        fields: fields
            .strings("fields")
            .map_err(recoded(ErrorCode::SEARCH_INVALID_FIELD))?,
        filters: filter_value(&mut fields)?,
        boost,
        bm25: fields
            .get("bm25")?
            .map(|bm25| bm25_params(&bm25, &bm25_path))
            .transpose()?,
        scoring: fields.choice("scoring", &SCORING_MODES)?,
        min_score: fields.number("minScore")?,
        term_match: fields
            .get("termMatch")?
            .map(|policy| term_match(&policy, &term_match_path))
            .transpose()?,
        tolerance: fields.whole_u32("tolerance")?,
        prefix_length: fields.whole_u32("prefixLength")?,
        prefix: fields.boolean("prefix")?,
        partial_words: fields.boolean("partialWords")?,
        exact: fields.boolean("exact")?,
        facets: fields
            .fields("facets")?
            .map(|facet_fields| facets(facet_fields, &facets_path))
            .transpose()?,
        sort: fields
            .get("sort")?
            .map(|sort| sort_fields(&sort, &sort_path))
            .transpose()
            .map_err(recoded(ErrorCode::SEARCH_INVALID_MODE))?,
        group: fields
            .fields("group")?
            .map(|group_fields| group(group_fields, &group_path))
            .transpose()?,
        limit: fields.size("limit")?,
        offset: fields.size("offset")?,
        search_after: fields.string("searchAfter")?,
        highlight: fields
            .fields("highlight")?
            .map(|highlight_fields| highlight(highlight_fields, &highlight_path))
            .transpose()?,
        pinned: fields
            .get("pinned")?
            .map(|pinned| pins(&pinned, &pinned_path))
            .transpose()?,
        mode: fields
            .choice("mode", &SEARCH_MODES)
            .map_err(recoded(ErrorCode::SEARCH_INVALID_MODE))?,
        vector: fields.fields("vector")?.map(vector).transpose()?,
        hybrid: fields.fields("hybrid")?.map(hybrid).transpose()?,
        rerank: fields
            .fields("rerank")
            .map_err(recoded(ErrorCode::RERANK_CONFIG_INVALID))?
            .map(|rerank_fields| rerank(rerank_fields, &rerank_path))
            .transpose()?,
        include_scores: fields.boolean("includeScores")?,
        include_score_components: fields.boolean("includeScoreComponents")?,
        document: fields
            .get("document")?
            .map(|document| projection(&document, &document_path))
            .transpose()?,
    };
    fields.finish()?;
    Ok(params)
}
