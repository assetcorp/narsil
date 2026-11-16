mod clauses;
mod vector;

use narsil::{ErrorCode, Map, QueryParams, ScoringMode, SearchMode, TermMatch, Value};

use clauses::{facet_specs, group_config, highlight_config, pins};
pub(crate) use clauses::{projection, sort_fields};
use vector::{bm25_params, hybrid_config, rerank_config, vector_query};

use super::constants::{MAX_PREFIX_LENGTH, MAX_TOLERANCE};
use super::reader::{Converted, Fields, details_of, refusal, safe_whole, shown, whole_count};

const SCORING_MODES: [(&str, ScoringMode); 3] = [
    ("local", ScoringMode::Local),
    ("dfs", ScoringMode::Dfs),
    ("broadcast", ScoringMode::Broadcast),
];
const SEARCH_MODES: [(&str, SearchMode); 3] = [
    ("fulltext", SearchMode::Fulltext),
    ("vector", SearchMode::Vector),
    ("hybrid", SearchMode::Hybrid),
];

fn integer_option(fields: &Fields<'_>, option: &str, maximum: u32) -> Converted<Option<u32>> {
    let Some(value) = fields.present(option) else {
        return Ok(None);
    };
    safe_whole(value)
        .and_then(|whole| u32::try_from(whole).ok())
        .map(Some)
        .ok_or_else(|| {
            refusal(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The query option \"{option}\" takes an integer from 0 to {maximum}, and this query sets {}",
                    shown(value)
                ),
            )
            .with_details(details_of(vec![
                ("option", Value::from(option)),
                ("value", Value::String(shown(value))),
                ("maximum", Value::Number(f64::from(maximum))),
            ]))
        })
}

fn partial_words(fields: &Fields<'_>) -> Converted<Option<bool>> {
    match fields.present("partialWords") {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(refusal(
            ErrorCode::CONFIG_INVALID,
            "The \"partialWords\" query option takes true or false",
        )),
    }
}

fn search_mode(fields: &Fields<'_>) -> Converted<Option<SearchMode>> {
    let Some(mode) = fields.present("mode") else {
        return Ok(None);
    };
    let found = mode.as_str().and_then(|text| {
        SEARCH_MODES
            .iter()
            .find(|(name, _)| *name == text)
            .map(|(_, mode)| *mode)
    });
    found.map(Some).ok_or_else(|| {
        refusal(
            ErrorCode::SEARCH_INVALID_MODE,
            format!(
                "A search takes the mode \"fulltext\", \"vector\", or \"hybrid\", while this query names \"{}\"",
                shown(mode)
            ),
        )
    })
}

fn term_match(fields: &Fields<'_>) -> Converted<Option<TermMatch>> {
    let Some(policy) = fields.get("termMatch") else {
        return Ok(None);
    };
    match policy {
        Value::String(text) if text == "all" => Ok(Some(TermMatch::All)),
        Value::String(text) if text == "any" => Ok(Some(TermMatch::Any)),
        Value::Number(count) => {
            let required = whole_count(count.ceil());
            Ok(Some(TermMatch::AtLeast(
                u32::try_from(required).unwrap_or(u32::MAX),
            )))
        }
        _ => Err(fields.wrong(
            "termMatch",
            ErrorCode::CONFIG_INVALID,
            "\"all\", \"any\", or a number",
        )),
    }
}

fn boost(fields: &Fields<'_>) -> Converted<Option<Vec<(String, f64)>>> {
    let Some(boost) = fields.get("boost") else {
        return Ok(None);
    };
    let Value::Object(boost) = boost else {
        return Err(fields.wrong(
            "boost",
            ErrorCode::SEARCH_INVALID_FIELD,
            "an object keyed by field name",
        ));
    };
    boost
        .iter()
        .map(|(field, multiplier)| match multiplier {
            Value::Number(multiplier) => Ok((field.clone(), *multiplier)),
            _ => Err(refusal(
                ErrorCode::CONFIG_INVALID,
                format!("The boost on field \"{field}\" must be a finite number"),
            )),
        })
        .collect::<Converted<Vec<_>>>()
        .map(Some)
}

fn search_after(fields: &Fields<'_>) -> Converted<Option<String>> {
    match fields.get("searchAfter") {
        None => Ok(None),
        Some(Value::String(cursor)) => Ok(Some(cursor.clone())),
        Some(_) => Err(refusal(
            ErrorCode::SEARCH_INVALID_CURSOR,
            "Failed to decode cursor: invalid base64 or JSON encoding",
        )),
    }
}

fn optional<T>(
    value: Option<&Value>,
    convert: impl FnOnce(&Value) -> Converted<T>,
) -> Converted<Option<T>> {
    value.map(convert).transpose()
}

pub(crate) fn query_params(params: &Map, max_rerank_window: usize) -> Converted<QueryParams> {
    let fields = Fields::new(params, "");
    let code = ErrorCode::CONFIG_INVALID;
    Ok(QueryParams {
        term: fields.string("term", code)?,
        fields: fields.strings("fields", ErrorCode::SEARCH_INVALID_FIELD)?,
        filters: fields.get("filters").cloned(),
        boost: boost(&fields)?,
        bm25: optional(fields.present("bm25"), bm25_params)?,
        scoring: fields.choice("scoring", code, &SCORING_MODES)?,
        min_score: fields.number("minScore", code)?,
        term_match: term_match(&fields)?,
        tolerance: integer_option(&fields, "tolerance", MAX_TOLERANCE)?,
        prefix_length: integer_option(&fields, "prefixLength", MAX_PREFIX_LENGTH)?,
        prefix: fields.boolean("prefix", code)?,
        partial_words: partial_words(&fields)?,
        exact: fields.boolean("exact", code)?,
        facets: optional(fields.get("facets"), facet_specs)?,
        sort: optional(fields.get("sort"), sort_fields)?,
        group: optional(fields.get("group"), group_config)?,
        limit: fields.count("limit", code)?,
        offset: fields.count("offset", code)?,
        search_after: search_after(&fields)?,
        highlight: optional(fields.get("highlight"), highlight_config)?,
        pinned: optional(fields.get("pinned"), pins)?,
        mode: search_mode(&fields)?,
        vector: optional(fields.get("vector"), |vector| {
            vector_query(vector, fields.get("mode"))
        })?,
        hybrid: optional(fields.get("hybrid"), hybrid_config)?,
        rerank: optional(fields.present("rerank"), |rerank| {
            rerank_config(rerank, max_rerank_window)
        })?,
        include_scores: fields.boolean("includeScores", code)?,
        include_score_components: fields.boolean("includeScoreComponents", code)?,
        document: optional(fields.get("document"), projection)?,
    })
}
