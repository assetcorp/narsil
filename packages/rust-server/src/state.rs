use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{ChangeSource, Narsil, NarsilError};

use crate::constants::{
    DEFAULT_IMPORT_BATCH_SIZE, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION,
    DEFAULT_MAX_CONCURRENT_REQUESTS, DEFAULT_MAX_CONCURRENT_TASKS, DEFAULT_MAX_FETCH_DOCUMENTS,
    DEFAULT_MAX_IMPORT_BYTES, DEFAULT_MAX_IMPORT_ERRORS, DEFAULT_MAX_LINE_BYTES,
    DEFAULT_MAX_RERANK_WINDOW, DEFAULT_MAX_RESTORE_BYTES, DEFAULT_MAX_RESULT_WINDOW,
    DEFAULT_MAX_TASK_PAGE_SIZE, MAX_BODY_BYTES_IN_FLIGHT_FRACTION, MAX_ENGINE_RERANK_WINDOW,
    MIN_COUNTED_SERVER_LIMIT,
};
use crate::errors::config_invalid_error;
use crate::feeds::Feeds;
use crate::http::budget::{BodyBudget, RequestGate};
use crate::http::cors::ResolvedCors;
use crate::http::in_flight::RequestsInFlight;
use crate::http::query_threads::QueryThreads;
use crate::options::{QueryIdentify, RequestHook, ServerLimits, ServerOptions};
use crate::tasks::TaskRegistry;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedLimits {
    pub(crate) max_body_bytes_in_flight: u64,
    pub(crate) max_body_bytes: u64,
    pub(crate) max_import_bytes: u64,
    pub(crate) max_restore_bytes: u64,
    pub(crate) max_line_bytes: u64,
    pub(crate) import_batch_size: u64,
    pub(crate) max_concurrent_requests: u64,
    pub(crate) max_result_window: u64,
    pub(crate) max_rerank_window: u64,
    pub(crate) max_fetch_documents: u64,
    pub(crate) max_import_errors: u64,
    pub(crate) max_task_page_size: u64,
    pub(crate) max_concurrent_tasks: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedBuild {
    pub(crate) version: String,
    pub(crate) git_sha: Option<String>,
    pub(crate) dirty: bool,
}

pub(crate) struct ServerState {
    pub(crate) engine: Arc<Narsil>,
    pub(crate) limits: ResolvedLimits,
    pub(crate) tasks: Arc<TaskRegistry>,
    pub(crate) allow_regex: bool,
    pub(crate) ready: AtomicBool,
    pub(crate) build: ResolvedBuild,
    pub(crate) cors: Option<ResolvedCors>,
    pub(crate) hook: Option<Arc<dyn RequestHook>>,
    pub(crate) identify: Option<Arc<dyn QueryIdentify>>,
    pub(crate) gate: Arc<RequestGate>,
    pub(crate) body_budget: Arc<BodyBudget>,
    pub(crate) requests: RequestsInFlight,
    pub(crate) queries: QueryThreads,
    pub(crate) feeds: Feeds,
    #[cfg(feature = "cluster")]
    pub(crate) cluster: Option<Arc<narsil_cluster::node::ClusterNode>>,
}

impl ServerState {
    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    #[cfg(feature = "cluster")]
    pub(crate) fn fronts_cluster(&self) -> bool {
        self.cluster.is_some()
    }

    #[cfg(not(feature = "cluster"))]
    pub(crate) fn fronts_cluster(&self) -> bool {
        false
    }

    #[cfg(feature = "cluster")]
    pub(crate) fn feed_source(&self) -> Arc<dyn ChangeSource> {
        match &self.cluster {
            Some(node) => node.feed_source(),
            None => self.engine.feed_source(),
        }
    }

    #[cfg(not(feature = "cluster"))]
    pub(crate) fn feed_source(&self) -> Arc<dyn ChangeSource> {
        self.engine.feed_source()
    }
}

fn check_counted(field: &str, value: Option<u64>) -> Result<(), NarsilError> {
    match value {
        Some(value) if value < MIN_COUNTED_SERVER_LIMIT => Err(config_invalid_error(format!(
            "limits.{field} must be a whole number of at least {MIN_COUNTED_SERVER_LIMIT}; however, this configuration sets it to {value}"
        ))),
        _ => Ok(()),
    }
}

pub(crate) fn check_limits(
    limits: &ServerLimits,
    engine_rerank_window: u64,
) -> Result<(), NarsilError> {
    check_counted("importBatchSize", limits.import_batch_size)?;
    check_counted("maxResultWindow", limits.max_result_window)?;
    check_counted("maxRerankWindow", limits.max_rerank_window)?;
    check_counted("maxFetchDocuments", limits.max_fetch_documents)?;
    check_counted("maxTaskPageSize", limits.max_task_page_size)?;
    if let Some(fraction) = limits.max_body_bytes_in_flight_fraction
        && !(fraction.is_finite() && (0.0..=MAX_BODY_BYTES_IN_FLIGHT_FRACTION).contains(&fraction))
    {
        return Err(config_invalid_error(format!(
            "limits.maxBodyBytesInFlightFraction must be a fraction from 0 to {MAX_BODY_BYTES_IN_FLIGHT_FRACTION}; however, this configuration sets it to {fraction}"
        )));
    }
    let cap = MAX_ENGINE_RERANK_WINDOW.min(engine_rerank_window);
    if let Some(window) = limits.max_rerank_window
        && window > cap
    {
        return Err(config_invalid_error(format!(
            "limits.maxRerankWindow must be at most {cap}, the largest window that the engine accepts; however, this configuration sets it to {window}"
        )));
    }
    Ok(())
}

fn body_bytes_in_flight(engine: &Narsil, fraction: f64) -> u64 {
    let limit = engine.get_memory_stats().process_limit_bytes;
    match limit {
        Some(limit) if fraction > 0.0 => (fraction * limit as f64).floor() as u64,
        _ => u64::MAX,
    }
}

pub(crate) fn resolve_limits(engine: &Narsil, limits: &ServerLimits) -> ResolvedLimits {
    let engine_rerank_window = engine.max_rerank_window() as u64;
    ResolvedLimits {
        max_body_bytes_in_flight: body_bytes_in_flight(
            engine,
            limits
                .max_body_bytes_in_flight_fraction
                .unwrap_or(DEFAULT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION),
        ),
        max_body_bytes: limits.max_body_bytes.unwrap_or(DEFAULT_MAX_BODY_BYTES),
        max_import_bytes: limits.max_import_bytes.unwrap_or(DEFAULT_MAX_IMPORT_BYTES),
        max_restore_bytes: limits
            .max_restore_bytes
            .unwrap_or(DEFAULT_MAX_RESTORE_BYTES),
        max_line_bytes: limits.max_line_bytes.unwrap_or(DEFAULT_MAX_LINE_BYTES),
        import_batch_size: limits
            .import_batch_size
            .unwrap_or(DEFAULT_IMPORT_BATCH_SIZE),
        max_concurrent_requests: limits
            .max_concurrent_requests
            .unwrap_or(DEFAULT_MAX_CONCURRENT_REQUESTS),
        max_result_window: limits
            .max_result_window
            .unwrap_or(DEFAULT_MAX_RESULT_WINDOW),
        max_rerank_window: limits
            .max_rerank_window
            .unwrap_or_else(|| DEFAULT_MAX_RERANK_WINDOW.min(engine_rerank_window)),
        max_fetch_documents: limits
            .max_fetch_documents
            .unwrap_or(DEFAULT_MAX_FETCH_DOCUMENTS),
        max_import_errors: limits
            .max_import_errors
            .unwrap_or(DEFAULT_MAX_IMPORT_ERRORS),
        max_task_page_size: limits
            .max_task_page_size
            .unwrap_or(DEFAULT_MAX_TASK_PAGE_SIZE),
        max_concurrent_tasks: limits
            .max_concurrent_tasks
            .unwrap_or(DEFAULT_MAX_CONCURRENT_TASKS),
    }
}

pub(crate) fn is_loopback(host: &str) -> bool {
    host == "127.0.0.1" || host == "::1" || host == "localhost" || host.starts_with("127.")
}

pub(crate) fn check_secure_binding(host: &str, options: &ServerOptions) -> Result<(), NarsilError> {
    if is_loopback(host) || options.on_request.is_some() || options.allow_insecure {
        return Ok(());
    }
    Err(config_invalid_error(format!(
        "Refusing to start: bound to a non-loopback address (\"{host}\") with no onRequest auth hook. The server exposes destructive admin endpoints (restore, drop, clear, rebalance, optimize). Resolve one of: (1) set options.onRequest to authenticate requests, (2) bind to 127.0.0.1, or (3) set options.allowInsecure: true if this address is on a trusted private network."
    )))
}
