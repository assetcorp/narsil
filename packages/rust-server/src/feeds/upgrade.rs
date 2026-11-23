use std::net::SocketAddr;
use std::sync::Arc;

use http::header::{CONNECTION, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use http::{HeaderMap, Request};
use hyper::body::Incoming;
use narsil::{ChangeSource, ErrorCode, NarsilError, Value};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;

use super::changes::ChangesFeed;
use super::core::Core;
use super::driver::{Protocol, drive};
use super::hub::{Hub, SERVER_CLOSING_REASON};
use super::outbox::Outbox;
use super::signals::SessionSignals;
use super::socket::{open_stream, serve_socket};
use super::sync::SyncFeed;
use super::wire::CLOSE_GOING_AWAY;
use super::{FeedKind, Feeds};
use crate::errors::{ServerError, server_codes};
use crate::http::body::drain_in_background;
use crate::http::pipeline::{Admission, admit, decode_segment, hook_context_of};
use crate::http::respond::{HttpResponse, empty, error, insert_header};
use crate::state::ServerState;

const WEBSOCKET_KEY_LENGTH: usize = 24;

fn has_token(headers: &HeaderMap, name: http::header::HeaderName, token: &str) -> bool {
    headers.get_all(name).iter().any(|value| {
        value.to_str().is_ok_and(|text| {
            text.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    })
}

fn websocket_key(headers: &HeaderMap) -> Option<String> {
    if !has_token(headers, UPGRADE, "websocket") || !has_token(headers, CONNECTION, "upgrade") {
        return None;
    }
    let key = headers.get(SEC_WEBSOCKET_KEY)?.to_str().ok()?;
    (key.len() == WEBSOCKET_KEY_LENGTH).then(|| key.to_string())
}

fn offers(headers: &HeaderMap, subprotocol: &str) -> bool {
    headers
        .get_all(SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|text| text.split(',').any(|part| part.trim() == subprotocol))
}

fn not_found() -> ServerError {
    ServerError::new(404, server_codes::NOT_FOUND, "Route not found")
}

fn not_enabled(kind: FeedKind, index: &str) -> ServerError {
    let (code, message) = match kind {
        FeedKind::Sync => (
            ErrorCode::SYNC_NOT_ENABLED,
            format!("Index \"{index}\" has device sync off"),
        ),
        FeedKind::Changes => (
            ErrorCode::CHANGES_NOT_ENABLED,
            format!("Index \"{index}\" has change capture off"),
        ),
    };
    ServerError::coded(code.as_str(), message)
        .with_detail("indexName", Value::String(index.to_string()))
}

fn feed_is_on(source: &dyn ChangeSource, kind: FeedKind, index: &str) -> Result<bool, NarsilError> {
    let answer = match kind {
        FeedKind::Sync => source.index_state(index).map(|state| state.is_some()),
        FeedKind::Changes => source.changes_state(index).map(|state| state.is_some()),
    };
    match answer {
        Err(failure) if failure.code() == ErrorCode::INDEX_NOT_FOUND => Ok(false),
        other => other,
    }
}

async fn check_feed(
    source: &Arc<dyn ChangeSource>,
    kind: FeedKind,
    index: &str,
) -> Result<(), ServerError> {
    let (source, name) = (Arc::clone(source), index.to_string());
    let answer = tokio::task::spawn_blocking(move || feed_is_on(source.as_ref(), kind, &name))
        .await
        .map_err(|_| ServerError::internal())?;
    match answer {
        Ok(true) => Ok(()),
        Ok(false) => Err(not_enabled(kind, index)),
        Err(failure) => Err(ServerError::from(failure)),
    }
}

struct Session {
    source: Arc<dyn ChangeSource>,
    hub: Arc<Hub>,
    kind: FeedKind,
    index: String,
    expires_at: Option<f64>,
}

async fn serve(session: Session, upgraded: hyper::upgrade::Upgraded) {
    let stream = open_stream(upgraded).await;
    let signals = Arc::new(SessionSignals::default());
    let held = Arc::clone(&signals);
    serve_socket(stream, signals, move |socket, inbound| async move {
        let mut outbox = Outbox::new(socket, Arc::clone(&session.hub.budget), session.expires_at);
        let Some(membership) = session.hub.join(&session.source, &session.index, &held) else {
            outbox.close(CLOSE_GOING_AWAY, SERVER_CLOSING_REASON);
            return;
        };
        let protocol = match session.kind {
            FeedKind::Sync => Protocol::Sync(Box::<SyncFeed>::default()),
            FeedKind::Changes => Protocol::Changes(Box::<ChangesFeed>::default()),
        };
        let core = Core::new(session.source, session.hub, session.index, held, outbox);
        drive(core, protocol, inbound).await;
        drop(membership);
    })
    .await;
}

fn switching(key: &str, subprotocol: &str) -> HttpResponse {
    let mut response = empty(101);
    insert_header(&mut response, "upgrade", "websocket");
    insert_header(&mut response, "connection", "Upgrade");
    insert_header(
        &mut response,
        "sec-websocket-accept",
        &derive_accept_key(key.as_bytes()),
    );
    insert_header(&mut response, "sec-websocket-protocol", subprotocol);
    response
}

fn hub_of(feeds: &Feeds, kind: FeedKind) -> Result<Arc<Hub>, ServerError> {
    feeds.hub(kind).cloned().ok_or_else(not_found)
}

pub(crate) async fn upgrade(
    state: Arc<ServerState>,
    feed: (FeedKind, String),
    mut request: Request<Incoming>,
    remote: SocketAddr,
) -> HttpResponse {
    let (kind, raw_name) = feed;
    let Some(key) = websocket_key(request.headers()) else {
        drain_in_background(request.into_body());
        return error(&not_found());
    };
    let subprotocol = kind.subprotocol();
    let Some(index) = decode_segment(&raw_name) else {
        return error(&ServerError::invalid(
            "A path segment holds a percent-escape the server cannot decode",
        ));
    };
    if !offers(request.headers(), subprotocol) {
        return error(&ServerError::invalid(format!(
            "The upgrade must offer the subprotocol {subprotocol}"
        )));
    }
    let context = state.hook.as_ref().map(|_| {
        hook_context_of(
            request.method(),
            request.uri().path(),
            request.headers(),
            remote,
        )
    });
    let expires_at = match admit(&state, context).await {
        Admission::Allowed(expires_at) => expires_at,
        Admission::Refused(refusal) => return error(&refusal),
    };
    let hub = match hub_of(&state.feeds, kind) {
        Ok(hub) => hub,
        Err(refusal) => return error(&refusal),
    };
    if let Err(refusal) = hub.refuse_when_closed() {
        return error(&refusal);
    }
    let source = state.feed_source();
    if let Err(refusal) = check_feed(&source, kind, &index).await {
        return error(&refusal);
    }
    let slot = match hub.reserve() {
        Ok(slot) => slot,
        Err(refusal) => return error(&refusal),
    };
    let pending = hyper::upgrade::on(&mut request);
    let tracked = state.feeds.tracker.enter();
    let session = Session {
        source,
        hub,
        kind,
        index,
        expires_at,
    };
    tokio::spawn(async move {
        let _tracked = tracked;
        let _slot = slot;
        if let Ok(upgraded) = pending.await {
            serve(session, upgraded).await;
        }
    });
    switching(&key, subprotocol)
}
