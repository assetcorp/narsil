use std::net::SocketAddr;
use std::sync::Arc;

use http::{Method, Request};
use hyper::body::Incoming;
use narsil::{ErrorCode, NarsilError};

use crate::errors::{ServerError, server_codes};
use crate::http::respond::{HttpResponse, error};
use crate::options::{FeedOptions, ServerOptions};
use crate::state::ServerState;

const DEFAULT_FEED_WINDOW_BYTES: u64 = 8_388_608;
const DEFAULT_MAX_FEED_CONNECTIONS: u64 = 10_000;
const DEFAULT_MAX_FEED_CATCH_UPS: u64 = 32;
const DEFAULT_MAX_FEED_BUFFERED_BYTES: u64 = 268_435_456;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FeedKind {
    Sync,
    Changes,
}

impl FeedKind {
    fn name(self) -> &'static str {
        match self {
            FeedKind::Sync => "sync",
            FeedKind::Changes => "changes",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedFeedOptions {
    pub(crate) window_bytes: u64,
    pub(crate) max_connections: u64,
    pub(crate) max_catch_ups: u64,
    pub(crate) max_buffered_bytes: u64,
}

pub(crate) struct Feeds {
    pub(crate) sync: Option<ResolvedFeedOptions>,
    pub(crate) changes: Option<ResolvedFeedOptions>,
}

fn resolve(
    kind: FeedKind,
    options: Option<&FeedOptions>,
) -> Result<Option<ResolvedFeedOptions>, NarsilError> {
    let Some(options) = options else {
        return Ok(None);
    };
    let fields = [
        ("windowBytes", options.window_bytes),
        ("maxConnections", options.max_connections),
        ("maxCatchUps", options.max_catch_ups),
        ("maxBufferedBytes", options.max_buffered_bytes),
    ];
    for (field, value) in fields {
        if let Some(value) = value
            && value < 1
        {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "{}.{field} must be a whole number of at least 1; however, this configuration sets it to {value}",
                    kind.name()
                ),
            ));
        }
    }
    Ok(Some(ResolvedFeedOptions {
        window_bytes: options.window_bytes.unwrap_or(DEFAULT_FEED_WINDOW_BYTES),
        max_connections: options
            .max_connections
            .unwrap_or(DEFAULT_MAX_FEED_CONNECTIONS),
        max_catch_ups: options.max_catch_ups.unwrap_or(DEFAULT_MAX_FEED_CATCH_UPS),
        max_buffered_bytes: options
            .max_buffered_bytes
            .unwrap_or(DEFAULT_MAX_FEED_BUFFERED_BYTES),
    }))
}

const SYNC_REFUSAL: &str = "Refusing to start: the device sync routes are on with no onRequest hook. A device receives the whole index, so set options.onRequest to admit only the user whose documents the index holds. allowInsecure does not lift this refusal.";
const CHANGES_REFUSAL: &str = "Refusing to start: the change feed is on with no onRequest hook. A subscriber receives every document of the index, so set options.onRequest to admit only the services that may read the whole index. allowInsecure does not lift this refusal.";

impl Feeds {
    pub(crate) fn of(options: &ServerOptions) -> Result<Feeds, NarsilError> {
        Ok(Feeds {
            sync: resolve(FeedKind::Sync, options.sync.as_ref())?,
            changes: resolve(FeedKind::Changes, options.changes.as_ref())?,
        })
    }

    pub(crate) fn check_authentication(&self, options: &ServerOptions) -> Result<(), NarsilError> {
        if options.on_request.is_some() {
            return Ok(());
        }
        let refusal = if self.sync.is_some() {
            Some(SYNC_REFUSAL)
        } else if self.changes.is_some() {
            Some(CHANGES_REFUSAL)
        } else {
            None
        };
        match refusal {
            Some(message) => Err(NarsilError::new(ErrorCode::CONFIG_INVALID, message)),
            None => Ok(()),
        }
    }

    pub(crate) fn close(&self) {}
}

pub(crate) fn feed_of(
    state: &ServerState,
    method: &Method,
    path: &str,
) -> Option<(FeedKind, String)> {
    if method != Method::GET {
        return None;
    }
    let rest = path.strip_prefix("/indexes/")?;
    let (name, tail) = rest.split_once('/')?;
    let kind = match tail {
        "sync/feed" if state.feeds.sync.is_some() => FeedKind::Sync,
        "changes/feed" if state.feeds.changes.is_some() => FeedKind::Changes,
        _ => return None,
    };
    Some((kind, name.to_string()))
}

pub(crate) async fn upgrade(
    state: Arc<ServerState>,
    feed: (FeedKind, String),
    request: Request<Incoming>,
    remote: SocketAddr,
) -> HttpResponse {
    let _ = (state, feed, request, remote);
    error(&ServerError::new(
        404,
        server_codes::NOT_FOUND,
        "Route not found",
    ))
}
