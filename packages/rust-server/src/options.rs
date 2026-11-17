use std::collections::BTreeMap;
use std::error::Error;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use narsil::{EmbeddingAdapter, RerankAdapter};

use crate::tasks::TaskStore;

/// The error type that a hook, an identify function, or a task store returns to report a failure.
pub type BoxError = Box<dyn Error + Send + Sync>;

/// A future that a hook returns, which the server awaits beside the body read.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The request that a [`RequestHook`] or a [`QueryIdentify`] function inspects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestContext {
    /// The HTTP method in upper case, such as `POST`.
    pub method: String,
    /// The path without its query string, as the client sent it.
    pub path: String,
    /// Every request header, keyed by its lower-case name.
    pub headers: BTreeMap<String, String>,
    /// The peer's IP address as text.
    pub remote_address: String,
}

/// The refusal that a [`RequestHook`] answers with, which the server sends as the error envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestDenial {
    /// The HTTP status of the answer, from 100 to 999.
    pub status: u16,
    /// The error code of the answer.
    pub code: String,
    /// The error message of the answer.
    pub message: String,
}

/// What a [`RequestHook`] decides about one request.
#[derive(Debug, Clone, PartialEq)]
pub enum RequestDecision {
    /// Lets the request through.
    Allow,
    /// Lets the request through, and closes a feed opened by it once the Unix time in milliseconds passes.
    AllowUntil(f64),
    /// Refuses the request with the given answer.
    Deny(RequestDenial),
}

/// Checks every request except the liveness, readiness, health, and version probes, beside the body read.
///
/// A failure, or an [`RequestDecision::AllowUntil`] that holds a number other than a finite one, answers 500
/// with `HOOK_ERROR`.
pub trait RequestHook: Send + Sync + 'static {
    /// Returns the decision for the request that `context` describes.
    fn check(&self, context: RequestContext) -> BoxFuture<Result<RequestDecision, BoxError>>;
}

impl<F, Fut> RequestHook for F
where
    F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<RequestDecision, BoxError>> + Send + 'static,
{
    fn check(&self, context: RequestContext) -> BoxFuture<Result<RequestDecision, BoxError>> {
        Box::pin(self(context))
    }
}

/// The person and the group that a recorded query belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryIdentity {
    /// The person who searched, where the caller knows them.
    pub person: Option<String>,
    /// The group that the person belongs to, where the caller knows it.
    pub group: Option<String>,
}

/// Names who sent a request to `POST /indexes/{name}/query-suggestions/record`, which the server records with
/// the query in place of any identity in the body.
pub trait QueryIdentify: Send + Sync + 'static {
    /// Returns the identity behind the request that `context` describes, or `None` for an anonymous request.
    fn identify(
        &self,
        context: RequestContext,
    ) -> BoxFuture<Result<Option<QueryIdentity>, BoxError>>;
}

impl<F, Fut> QueryIdentify for F
where
    F: Fn(RequestContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Option<QueryIdentity>, BoxError>> + Send + 'static,
{
    fn identify(
        &self,
        context: RequestContext,
    ) -> BoxFuture<Result<Option<QueryIdentity>, BoxError>> {
        Box::pin(self(context))
    }
}

/// The origins, methods, and headers that a browser on another origin may use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CorsOptions {
    /// The allowed origins, where `None` allows every origin and a list answers each listed origin by name.
    pub origins: Option<Vec<String>>,
    /// The allowed methods, where `None` allows GET, POST, PUT, PATCH, DELETE, and OPTIONS.
    pub methods: Option<Vec<String>>,
    /// The allowed request headers, where `None` allows `Content-Type` and `Authorization`.
    pub headers: Option<Vec<String>>,
}

/// The limits that the server enforces on requests, where `None` keeps the default of each.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServerLimits {
    /// The longest JSON body in bytes, 16 MiB by default.
    pub max_body_bytes: Option<u64>,
    /// The longest NDJSON import body in bytes, 100 MiB by default.
    pub max_import_bytes: Option<u64>,
    /// The longest restore or document export body in bytes, 64 GiB by default.
    pub max_restore_bytes: Option<u64>,
    /// The longest NDJSON line in bytes, 4 MiB by default.
    pub max_line_bytes: Option<u64>,
    /// The number of NDJSON lines that the server inserts at a time, 1,000 by default.
    pub import_batch_size: Option<u64>,
    /// The number of requests that the server runs at once, where 0, the default, sets no limit.
    pub max_concurrent_requests: Option<u64>,
    /// The share of the process memory limit that the bodies in flight may hold, 0.1 by default, where 0 sets
    /// no limit.
    pub max_body_bytes_in_flight_fraction: Option<f64>,
    /// The highest `offset + limit` of a search, 10,000 by default.
    pub max_result_window: Option<u64>,
    /// The largest rerank window, 100 by default.
    pub max_rerank_window: Option<u64>,
    /// The most documents that one read returns, 10,000 by default.
    pub max_fetch_documents: Option<u64>,
    /// The most line errors that an import reports, 100 by default.
    pub max_import_errors: Option<u64>,
    /// The largest page of task records, 1,000 by default.
    pub max_task_page_size: Option<u64>,
    /// The number of tasks that run at once, 4 by default.
    pub max_concurrent_tasks: Option<u64>,
}

/// The build identity that `GET /version` reports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildInfo {
    /// The version, which is this crate's version by default.
    pub version: Option<String>,
    /// The commit that the server was built from.
    pub git_sha: Option<String>,
    /// Whether the build held uncommitted changes.
    pub dirty: bool,
}

/// The settings of the device sync feed or the change feed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedOptions {
    /// The bytes that the server sends to one connection before the client acknowledges them, 8 MiB by default.
    pub window_bytes: Option<u64>,
    /// The connections that the feed holds at once, 10,000 by default.
    pub max_connections: Option<u64>,
    /// The connections that read history at once, 32 by default.
    pub max_catch_ups: Option<u64>,
    /// The bytes that every connection of the feed may hold unsent, 256 MiB by default.
    pub max_buffered_bytes: Option<u64>,
}

/// The settings of a server, where the default binds to loopback on port 9876 with the default limits.
#[derive(Clone, Default)]
pub struct ServerOptions {
    /// The address to bind to, `127.0.0.1` by default.
    pub host: Option<String>,
    /// The port to bind to, 9876 by default, where 0 asks the system for a free port.
    pub port: Option<u16>,
    /// The cross-origin settings, where `None` sends no CORS header.
    pub cors: Option<CorsOptions>,
    /// The request check, which runs on every request except the probes.
    pub on_request: Option<Arc<dyn RequestHook>>,
    /// The build identity that `GET /version` reports.
    pub build: BuildInfo,
    /// The embedding adapters that the server registers on the engine by name.
    pub embedding_adapters: BTreeMap<String, Arc<dyn EmbeddingAdapter>>,
    /// The rerank adapters that the server registers on the engine by name.
    pub rerank_adapters: BTreeMap<String, Arc<dyn RerankAdapter>>,
    /// The request limits.
    pub limits: ServerLimits,
    /// The store of task records, an in-memory store by default.
    pub task_store: Option<Arc<dyn TaskStore>>,
    /// The identifier that marks the tasks that this server runs, a random UUID by default.
    pub instance_id: Option<String>,
    /// Lets the server bind to an address other than loopback without a request check.
    pub allow_insecure: bool,
    /// Whether searches may use regular-expression patterns, which is true by default.
    pub allow_regex: Option<bool>,
    /// The device sync feed, where `None` serves no feed.
    pub sync: Option<FeedOptions>,
    /// The change feed, where `None` serves no feed.
    pub changes: Option<FeedOptions>,
    /// Names who recorded each query.
    pub query_suggestions_identify: Option<Arc<dyn QueryIdentify>>,
}
