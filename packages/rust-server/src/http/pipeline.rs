use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::FutureExt;
use http::header::ORIGIN;
use http::{HeaderMap, Method, Request};
use hyper::body::Incoming;
use narsil::{Map, Value};

use super::body::{BodyRead, declared_body_bytes, drain_in_background, read_body};
use super::parse_memory::{body_parse_refusal, route_parse_refusal};
use super::respond::{HttpResponse, error, held_until_sent, insert_header};
use super::routes::{BodyRule, Route, RouteOptions, match_route};
use super::spool::{SpoolOutcome, SpooledBody, spool_body};
use crate::errors::{ServerError, server_codes};
use crate::handlers::dispatch;
use crate::options::{RequestContext, RequestDecision};
use crate::state::ServerState;

pub(crate) struct RouteContext {
    pub(crate) params: Vec<String>,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Option<Bytes>,
    pub(crate) spooled: Option<SpooledBody>,
    pub(crate) hook_context: Option<RequestContext>,
}

impl RouteContext {
    pub(crate) fn param(&self, at: usize) -> &str {
        self.params.get(at).map_or("", String::as_str)
    }

    pub(crate) fn query_value(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

pub(crate) fn decode_segment(raw: &str) -> Option<String> {
    if !raw.contains('%') {
        return Some(raw.to_string());
    }
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()
        .filter(|_| well_formed_escapes(raw))
        .map(|decoded| decoded.into_owned())
}

fn well_formed_escapes(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = |offset: usize| bytes.get(at + offset).is_some_and(u8::is_ascii_hexdigit);
            if !(hex(1) && hex(2)) {
                return false;
            }
            at += 3;
        } else {
            at += 1;
        }
    }
    true
}

pub(crate) fn hook_context_of(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> RequestContext {
    let mut captured = BTreeMap::new();
    for (name, value) in headers {
        let text = String::from_utf8_lossy(value.as_bytes()).into_owned();
        captured
            .entry(name.as_str().to_string())
            .and_modify(|held: &mut String| {
                held.push_str(", ");
                held.push_str(&text);
            })
            .or_insert(text);
    }
    RequestContext {
        method: method.as_str().to_ascii_uppercase(),
        path: path.to_string(),
        headers: captured,
        remote_address: remote.ip().to_string(),
    }
}

pub(crate) enum Admission {
    Allowed(Option<f64>),
    Refused(ServerError),
}

fn hook_failure() -> ServerError {
    ServerError::new(
        500,
        server_codes::HOOK_ERROR,
        "The onRequest hook threw an error",
    )
}

pub(crate) async fn admit(state: &ServerState, context: Option<RequestContext>) -> Admission {
    let (Some(hook), Some(context)) = (&state.hook, context) else {
        return Admission::Allowed(None);
    };
    let decision = AssertUnwindSafe(async move { hook.check(context).await })
        .catch_unwind()
        .await;
    match decision {
        Ok(Ok(RequestDecision::Allow)) => Admission::Allowed(None),
        Ok(Ok(RequestDecision::AllowUntil(expires_at))) if expires_at.is_finite() => {
            Admission::Allowed(Some(expires_at))
        }
        Ok(Ok(RequestDecision::Deny(denial))) => Admission::Refused(ServerError::new(
            denial.status,
            &denial.code,
            denial.message,
        )),
        _ => Admission::Refused(hook_failure()),
    }
}

enum ReadBody {
    Bytes(Option<Bytes>),
    Spooled(SpooledBody),
    Refused(ServerError),
    Ended,
}

async fn read_route_body(
    state: &ServerState,
    options: RouteOptions,
    body: Incoming,
    declared: Option<u64>,
    hold: &mut super::budget::BodyHold,
) -> ReadBody {
    let limits = &state.limits;
    let max_bytes = match options.body {
        BodyRule::Ignored => {
            drain_in_background(body);
            return ReadBody::Bytes(None);
        }
        BodyRule::Json => limits.max_body_bytes,
        BodyRule::Import => limits.max_import_bytes,
        BodyRule::Spooled => limits.max_restore_bytes,
    };
    if options.body == BodyRule::Spooled {
        return match spool_body(body, max_bytes).await {
            SpoolOutcome::Stored(spooled) => ReadBody::Spooled(spooled),
            SpoolOutcome::Refused(refusal) => ReadBody::Refused(refusal),
            SpoolOutcome::Ended => ReadBody::Ended,
        };
    }
    match read_body(body, max_bytes, declared, hold).await {
        BodyRead::Complete(bytes) => ReadBody::Bytes(Some(bytes)),
        BodyRead::Refused(refusal) => ReadBody::Refused(refusal),
        BodyRead::Ended => ReadBody::Ended,
    }
}

fn query_pairs(query: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn not_found() -> ServerError {
    ServerError::new(404, server_codes::NOT_FOUND, "Route not found")
}

async fn answer_on_query_threads<H: Send + Sync + Unpin + 'static>(
    state: &Arc<ServerState>,
    route: Route,
    context: RouteContext,
    held: H,
) -> HttpResponse {
    let shared = Arc::clone(state);
    let answered = state
        .queries
        .run(move || {
            let outcome = match route_parse_refusal(&shared.engine, route, context.body.as_ref()) {
                Some(refusal) => Err(refusal),
                None => crate::handlers::search::answer(&shared, route, &context),
            };
            (outcome, held)
        })
        .await;
    match answered {
        Some((Ok(reply), held)) => held_until_sent(reply.into_response(), held),
        Some((Err(failure), _)) => error(&failure),
        None => error(&ServerError::internal()),
    }
}

fn with_cors(state: &ServerState, origin: &str, mut response: HttpResponse) -> HttpResponse {
    if let Some(cors) = &state.cors {
        for (name, value) in cors.origin_headers(origin) {
            insert_header(&mut response, name, &value);
        }
    }
    response
}

pub(crate) async fn serve(
    state: Arc<ServerState>,
    request: Request<Incoming>,
    remote: SocketAddr,
) -> HttpResponse {
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if request.method() == Method::OPTIONS
        && let Some(cors) = &state.cors
    {
        drain_in_background(request.into_body());
        return cors.preflight(&origin);
    }
    if let Some(feed) = crate::feeds::feed_of(&state, request.method(), request.uri().path()) {
        let response = crate::feeds::upgrade(Arc::clone(&state), feed, request, remote).await;
        return with_cors(&state, &origin, response);
    }
    let response = route(&state, request, remote).await;
    with_cors(&state, &origin, response)
}

async fn route(
    state: &Arc<ServerState>,
    request: Request<Incoming>,
    remote: SocketAddr,
) -> HttpResponse {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_string();
    let Some(matched) = match_route(&parts.method, &path) else {
        drain_in_background(body);
        return error(&not_found());
    };
    let options = matched.entry.options;
    let route = matched.entry.route;
    let mut params = Vec::with_capacity(matched.raw_params.len());
    for raw in &matched.raw_params {
        let Some(decoded) = decode_segment(raw) else {
            drain_in_background(body);
            let mut details = Map::new();
            details.insert("segment", Value::String((*raw).to_string()));
            return error(
                &ServerError::invalid(
                    "A path segment holds a percent-escape the server cannot decode",
                )
                .with_details(details),
            );
        };
        params.push(decoded);
    }
    let uses_hook = state.hook.is_some() && !options.skip_hooks;
    let hook_context = (uses_hook || options.captures_context)
        .then(|| hook_context_of(&parts.method, &path, &parts.headers, remote));
    let declared = declared_body_bytes(&parts.headers);
    let mut hold = state.body_budget.hold();
    let admission_context = if uses_hook {
        hook_context.clone()
    } else {
        None
    };
    let (read, admission) = if options.body == BodyRule::Spooled {
        let admission = admit(state, admission_context).await;
        if let Admission::Refused(refusal) = admission {
            drain_in_background(body);
            return error(&refusal);
        }
        let read = read_route_body(state, options, body, declared, &mut hold).await;
        (read, admission)
    } else {
        tokio::join!(
            read_route_body(state, options, body, declared, &mut hold),
            admit(state, admission_context)
        )
    };
    let (body, spooled) = match read {
        ReadBody::Bytes(bytes) => (bytes, None),
        ReadBody::Spooled(spooled) => (None, Some(spooled)),
        ReadBody::Refused(refusal) => return error(&refusal),
        ReadBody::Ended => return error(&ServerError::internal()),
    };
    if let Admission::Refused(refusal) = admission {
        return error(&refusal);
    }
    let pass = if options.skip_hooks {
        None
    } else {
        match state.gate.try_acquire() {
            Some(pass) => Some(pass),
            None => {
                return error(&ServerError::new(
                    429,
                    server_codes::TOO_MANY_REQUESTS,
                    "The server is at capacity; retry shortly",
                ));
            }
        }
    };
    if options.body == BodyRule::Json
        && !options.on_query_threads
        && let Some(refusal) = body_parse_refusal(&state.engine, route, body.as_ref()).await
    {
        return error(&refusal);
    }
    let context = RouteContext {
        params,
        query: query_pairs(parts.uri.query()),
        headers: parts.headers,
        body,
        spooled,
        hook_context,
    };
    let in_flight = state.requests.enter();
    if options.on_query_threads && !state.fronts_cluster() {
        return answer_on_query_threads(state, route, context, (pass, hold, in_flight)).await;
    }
    let handled = AssertUnwindSafe(dispatch(Arc::clone(state), route, context)).catch_unwind();
    let running = tokio::spawn(async move { (handled.await, (pass, hold, in_flight)) });
    match running.await {
        Ok((Ok(Ok(response)), held)) => held_until_sent(response, held),
        Ok((Ok(Err(failure)), _)) => error(&failure),
        Ok((Err(_), _)) | Err(_) => error(&ServerError::internal()),
    }
}
