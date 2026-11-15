mod changes;
mod constants;
mod core;
mod driver;
mod hub;
mod limits;
mod options;
mod outbox;
mod signals;
mod socket;
mod sync;
mod upgrade;
mod wire;

use std::sync::Arc;
use std::time::Duration;

use http::Method;
use narsil::{ErrorCode, NarsilError};

use crate::options::ServerOptions;
use crate::state::ServerState;
use constants::FEED_CLOSE_DRAIN_DEADLINE_MS;
use hub::Hub;
use limits::ConnectionTracker;

pub(crate) use upgrade::upgrade;

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

    fn subprotocol(self) -> &'static str {
        match self {
            FeedKind::Sync => wire::SYNC_SUBPROTOCOL,
            FeedKind::Changes => wire::CHANGES_SUBPROTOCOL,
        }
    }
}

pub(crate) struct Feeds {
    pub(crate) sync: Option<Arc<Hub>>,
    pub(crate) changes: Option<Arc<Hub>>,
    tracker: Arc<ConnectionTracker>,
}

const SYNC_REFUSAL: &str = "Refusing to start: the device sync routes are on with no onRequest hook. A device receives the whole index, so set options.onRequest to admit only the user whose documents the index holds. allowInsecure does not lift this refusal.";
const CHANGES_REFUSAL: &str = "Refusing to start: the change feed is on with no onRequest hook. A subscriber receives every document of the index, so set options.onRequest to admit only the services that may read the whole index. allowInsecure does not lift this refusal.";

impl Feeds {
    pub(crate) fn of(server: &ServerOptions) -> Result<Feeds, NarsilError> {
        let allow_regex = server.allow_regex.unwrap_or(true);
        let hub_of = |kind: FeedKind, feed| -> Result<Option<Arc<Hub>>, NarsilError> {
            Ok(options::resolve(kind, feed)?
                .map(|resolved| Arc::new(Hub::new(kind, resolved, allow_regex))))
        };
        Ok(Feeds {
            sync: hub_of(FeedKind::Sync, server.sync.as_ref())?,
            changes: hub_of(FeedKind::Changes, server.changes.as_ref())?,
            tracker: Arc::new(ConnectionTracker::default()),
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

    fn hub(&self, kind: FeedKind) -> Option<&Arc<Hub>> {
        match kind {
            FeedKind::Sync => self.sync.as_ref(),
            FeedKind::Changes => self.changes.as_ref(),
        }
    }

    pub(crate) async fn close(&self) {
        for hub in [&self.sync, &self.changes].into_iter().flatten() {
            hub.close();
        }
        self.tracker
            .wait_idle(Duration::from_millis(FEED_CLOSE_DRAIN_DEADLINE_MS))
            .await;
    }
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
