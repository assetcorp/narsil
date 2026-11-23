use std::collections::HashSet;
use std::ops::Range;
use std::sync::Arc;

use crate::adapters::RerankAdapter;
use crate::engine::adapter_registry::AdapterRegistry;
use crate::engine::query::pagination::{PositionWindow, page_by_position};
use crate::engine::query::rerank::{
    first_stage_depth, placed_hits, reorder_by_rerank, rerank_query_text, rerank_text_of,
    resolve_rerank, score_documents,
};
use crate::engine::registration::register_rerank_in;
use crate::engine::rerank_settings::RerankSettings;
use crate::engine::{Hit, Pin, QueryParams};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::CompiledSchema;
use crate::value::{Map, Value};

/// The rerank step of a query once checked: the adapter, the fields whose text it reads, the text that it compares
/// each hit with, and how many of the best hits it reranks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedRerank {
    /// The name of the rerank adapter.
    pub adapter: String,
    /// The text fields that the adapter reads.
    pub fields: Vec<String>,
    /// The text that the adapter compares each hit with.
    pub query: String,
    /// How many of the best hits the adapter reranks.
    pub window: usize,
}

/// Checks the rerank step of `params` against the schema that an index stores, as one engine checks it.
///
/// # Errors
///
/// Fails with `SEARCH_INVALID_MODE` for a query that also sorts and with `RERANK_CONFIG_INVALID` for a bad
/// setting or a query without rerank.
pub fn check_rerank(
    params: &QueryParams,
    schema: &Value,
    hybrid_depth: Option<usize>,
    max_window: usize,
) -> Result<CheckedRerank> {
    let Some(rerank) = &params.rerank else {
        return Err(NarsilError::new(
            ErrorCode::RERANK_CONFIG_INVALID,
            "The query sets no rerank step",
        ));
    };
    let Value::Object(definition) = schema else {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            "An index schema must be an object",
        ));
    };
    let compiled = CompiledSchema::of(definition.clone())?;
    let plan = resolve_rerank(
        params,
        rerank,
        &compiled,
        hybrid_depth,
        max_window,
        rerank_query_text(params),
    )?;
    Ok(CheckedRerank {
        adapter: plan.adapter,
        fields: plan.fields,
        query: plan.query,
        window: plan.window,
    })
}

/// Returns how deep the first stage of a reranked query reads, as one engine reads it.
///
/// # Errors
///
/// Fails with `SEARCH_RESULT_WINDOW_EXCEEDED` where the page ends past the result window or starts at a hybrid
/// query's depth.
pub fn rerank_first_stage_depth(
    hybrid_depth: Option<usize>,
    window: usize,
    cursor_depth: usize,
    offset: usize,
    limit: usize,
) -> Result<usize> {
    first_stage_depth(hybrid_depth, window, cursor_depth, offset, limit)
}

/// Returns the text that a rerank adapter reads from `document`: each string, and each string of a list, of
/// `fields`, one per line.
pub fn rerank_text(document: &Map, fields: &[String]) -> String {
    rerank_text_of(document, fields)
}

/// The rerank adapters that a cluster coordinator scores hits with, and the timeout and window that its calls
/// follow, as one engine holds them without an engine around them.
pub struct RerankHost {
    registry: AdapterRegistry,
}

impl RerankHost {
    /// Returns a host that holds no adapter, whose calls wait `timeout_ms` and rerank at most `max_window` hits,
    /// each taking the engine's default where it is `None`.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where `timeout_ms` or `max_window` falls outside the range that an engine accepts.
    pub fn new(timeout_ms: Option<u64>, max_window: Option<usize>) -> Result<RerankHost> {
        let settings = RerankSettings::checked(timeout_ms, max_window)?;
        Ok(RerankHost {
            registry: AdapterRegistry::with_rerank(settings),
        })
    }

    /// Registers `adapter` under `name`, replacing any adapter registered under it before.
    ///
    /// # Errors
    ///
    /// Fails with `RERANK_CONFIG_INVALID` where `name` is empty once trimmed.
    pub fn register(&self, name: &str, adapter: Arc<dyn RerankAdapter>) -> Result<()> {
        register_rerank_in(&self.registry, name, adapter)
    }

    /// Returns the most hits that one query may rerank.
    pub fn max_window(&self) -> usize {
        self.registry.rerank_settings().max_window
    }

    /// Scores `documents` against `query` through the adapter registered under `adapter`, blocking the calling
    /// thread until it answers or its timeout passes.
    ///
    /// # Errors
    ///
    /// Fails with `RERANK_CONFIG_INVALID` where no adapter is registered under `adapter` and with `RERANK_FAILED`
    /// where the adapter fails, panics, returns unusable scores, or times out.
    pub fn score(&self, adapter: &str, query: &str, documents: Vec<String>) -> Result<Vec<f64>> {
        score_documents(&self.registry, adapter, query, documents)
    }
}

/// Reorders the first `window_size` hits of `ranked` by `scores`, as one engine reorders them, and rescales the
/// rest so that they stay below the reranked ones.
pub fn reorder_hits_by_rerank(ranked: Vec<Hit>, window_size: usize, scores: &[f64]) -> Vec<Hit> {
    reorder_by_rerank(ranked, window_size, scores).hits
}

/// Places `pins` into `hits`, as one engine places them, where a pin outside the hits comes in with a score of 0
/// and no document.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the hits or the pins exceed the native layout.
pub fn place_pinned_hits(hits: &[Hit], pins: Option<&[Pin]>) -> Result<Vec<Hit>> {
    placed_hits(hits, pins)
}

/// Takes a page of `placed` by position, as one engine pages a reranked query, and returns the range that it
/// covers and the cursor of the next page.
pub fn page_hits_by_position(
    placed: &[Hit],
    organic: &[&str],
    start: usize,
    limit: usize,
    pinned_ids: Option<&HashSet<&str>>,
    binding: &str,
) -> (Range<usize>, Option<String>) {
    let page = page_by_position(
        placed,
        organic,
        &PositionWindow {
            start,
            limit,
            pinned_ids,
            binding,
        },
    );
    (page.range, page.cursor)
}
