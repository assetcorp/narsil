use std::collections::HashSet;

use super::super::constants::{DEFAULT_RERANK_WINDOW, MIN_RERANK_WINDOW};
use super::super::params::{QueryParams, RerankConfig};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::CompiledSchema;
use crate::util::text::javascript_trim;

/// The rerank step of a query once the engine has checked it.
pub(crate) struct RerankPlan {
    pub(crate) adapter: String,
    pub(crate) fields: Vec<String>,
    pub(crate) query: String,
    pub(crate) window: usize,
}

fn invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::RERANK_CONFIG_INVALID, message)
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !javascript_trim(text).is_empty())
}

/// Returns the text that a reranked query compares each hit with: `rerank.query` where the query gives one, and
/// otherwise its term or its vector clause's text.
///
/// The engine reads it before it embeds the vector clause's text, which clears that text.
pub(crate) fn rerank_query_text(params: &QueryParams) -> Option<String> {
    if let Some(query) = params
        .rerank
        .as_ref()
        .and_then(|rerank| rerank.query.as_deref())
    {
        return non_blank(Some(query)).map(str::to_owned);
    }
    non_blank(params.term.as_deref())
        .or_else(|| {
            non_blank(
                params
                    .vector
                    .as_ref()
                    .and_then(|clause| clause.text.as_deref()),
            )
        })
        .map(str::to_owned)
}

fn require_text_fields(fields: &[String], schema: &CompiledSchema) -> Result<Vec<String>> {
    if fields.is_empty() {
        return Err(invalid(
            "rerank.fields must list at least one text field".into(),
        ));
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(fields.len());
    for field in fields {
        let text_valued = schema
            .field_type(field)
            .is_some_and(|field_type| field_type.base.is_string_valued());
        if !text_valued {
            return Err(invalid(format!(
                "rerank.fields gives \"{field}\", which the schema does not declare as a text field"
            )));
        }
        if !seen.insert(field.as_str()) {
            return Err(invalid(format!(
                "rerank.fields gives \"{field}\" more than once"
            )));
        }
    }
    Ok(fields.to_vec())
}

fn require_window(
    window: Option<usize>,
    max_window: usize,
    hybrid_depth: Option<usize>,
) -> Result<usize> {
    let Some(window) = window else {
        return Ok(DEFAULT_RERANK_WINDOW
            .min(max_window)
            .min(hybrid_depth.unwrap_or(max_window)));
    };
    if !(MIN_RERANK_WINDOW..=max_window).contains(&window) {
        return Err(invalid(format!(
            "rerank.window must be a whole number from {MIN_RERANK_WINDOW} to {max_window}"
        )));
    }
    match hybrid_depth {
        Some(depth) if window > depth => Err(invalid(format!(
            "rerank.window is {window}, above the hybrid.depth of {depth} that a hybrid query reranks from"
        ))),
        _ => Ok(window),
    }
}

/// Checks the rerank step of a query in the order that every Narsil engine checks it, raising
/// `SEARCH_INVALID_MODE` for a query that also sorts and `RERANK_CONFIG_INVALID` for a bad setting.
pub(crate) fn resolve_rerank(
    params: &QueryParams,
    rerank: &RerankConfig,
    schema: &CompiledSchema,
    hybrid_depth: Option<usize>,
    max_window: usize,
    query_text: Option<String>,
) -> Result<RerankPlan> {
    if params.sort.as_ref().is_some_and(|sort| !sort.is_empty()) {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_MODE,
            "A query cannot carry both rerank and a sort, because each of them sets the order of the hits",
        ));
    }
    if rerank.adapter.is_empty() {
        return Err(invalid(
            "rerank.adapter must give the name of a registered rerank adapter".into(),
        ));
    }
    let fields = require_text_fields(&rerank.fields, schema)?;
    let window = require_window(rerank.window, max_window, hybrid_depth)?;
    let Some(query) = query_text else {
        return Err(invalid(
            "A reranked query needs text to compare each hit with: set rerank.query, term, or vector.text".into(),
        ));
    };
    Ok(RerankPlan {
        adapter: rerank.adapter.clone(),
        fields,
        query,
        window,
    })
}
