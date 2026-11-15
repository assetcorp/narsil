#![doc = include_str!("../README.md")]

mod constants;
mod errors;
mod feeds;
mod handlers;
mod http;
mod ids;
mod maintenance;
mod options;
mod server;
mod state;
mod tasks;

pub use errors::{http_status_for_code, server_codes};
pub use options::{
    BoxError, BoxFuture, BuildInfo, CorsOptions, FeedOptions, QueryIdentify, QueryIdentity,
    RequestContext, RequestDecision, RequestDenial, RequestHook, ServerLimits, ServerOptions,
};
pub use server::NarsilServer;
pub use tasks::{
    InMemoryTaskStore, PersistenceTaskStore, StoreFuture, TaskRecord, TaskStatus, TaskStore,
};
