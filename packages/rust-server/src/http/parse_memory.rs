use std::sync::Arc;

use bytes::Bytes;
use narsil::{Map, Narsil, ParseKind, ParseShortfall, Value};

use super::routes::Route;
use crate::constants::{
    PARSE_ARRAY_BYTES, PARSE_OBJECT_BYTES, PARSE_PROPERTY_BYTES, PARSE_SCALAR_BYTES,
    PARSE_STRING_BYTES, PARSE_STRING_BYTES_PER_BYTE, PARSE_TEXT_BYTES_PER_BODY_BYTE,
    PARSE_WORST_BYTES_PER_BODY_BYTE,
};
use crate::errors::{ServerError, server_codes};

const PARSE_WOULD_FILL_MEMORY_REASON: &str = "parse_would_fill_memory";
const PARSE_EXCEEDS_MEMORY_REASON: &str = "parse_exceeds_memory";

fn is_scalar_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'+' | b'.')
}

fn closing_quote_of(raw: &[u8], from: usize) -> usize {
    let mut at = from;
    while let Some(found) = raw
        .get(at..)
        .and_then(|rest| rest.iter().position(|b| *b == b'"'))
    {
        let quote = at + found;
        let backslashes = raw[from..quote]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        if backslashes % 2 == 0 {
            return quote;
        }
        at = quote + 1;
    }
    raw.len()
}

fn scanned_parse_bytes(raw: &[u8]) -> u64 {
    let (mut objects, mut arrays, mut properties) = (0u64, 0u64, 0u64);
    let (mut strings, mut string_bytes, mut scalars) = (0u64, 0u64, 0u64);
    let mut in_scalar = false;
    let mut at = 0;
    while let Some(&byte) = raw.get(at) {
        if byte == b'"' {
            let end = closing_quote_of(raw, at + 1);
            strings += 1;
            string_bytes += (end - at).saturating_sub(1) as u64;
            at = end;
            in_scalar = false;
        } else if is_scalar_byte(byte) {
            scalars += u64::from(!in_scalar);
            in_scalar = true;
        } else {
            in_scalar = false;
            match byte {
                b'{' => objects += 1,
                b'[' => arrays += 1,
                b':' => properties += 1,
                _ => {}
            }
        }
        at += 1;
    }
    (raw.len() as u64)
        .saturating_mul(PARSE_TEXT_BYTES_PER_BODY_BYTE)
        .saturating_add(objects.saturating_mul(PARSE_OBJECT_BYTES))
        .saturating_add(arrays.saturating_mul(PARSE_ARRAY_BYTES))
        .saturating_add(properties.saturating_mul(PARSE_PROPERTY_BYTES))
        .saturating_add(strings.saturating_mul(PARSE_STRING_BYTES))
        .saturating_add(string_bytes.saturating_mul(PARSE_STRING_BYTES_PER_BYTE))
        .saturating_add(scalars.saturating_mul(PARSE_SCALAR_BYTES))
}

fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

fn refusal_of(body_bytes: usize, shortfall: &ParseShortfall) -> ServerError {
    let (status, code, reason, message) = match shortfall.exceeds_limit {
        true => (
            413,
            server_codes::PAYLOAD_TOO_LARGE,
            PARSE_EXCEEDS_MEMORY_REASON,
            format!(
                "Parsing this {body_bytes}-byte body can take up to {} bytes of memory, more than the {} bytes that the server allows its process even when idle. Send the request in smaller parts.",
                shortfall.parse_bytes, shortfall.block_bytes
            ),
        ),
        false => (
            429,
            server_codes::TOO_MANY_REQUESTS,
            PARSE_WOULD_FILL_MEMORY_REASON,
            format!(
                "Parsing this {body_bytes}-byte body can take up to {} bytes of memory, which with the {} bytes already in use would pass the server's limit of {} bytes. Retry once the requests in progress finish.",
                shortfall.parse_bytes, shortfall.process_bytes, shortfall.block_bytes
            ),
        ),
    };
    let mut details = Map::new();
    details.insert("reason", Value::from(reason));
    details.insert("bodyBytes", number(body_bytes as u64));
    details.insert("parseBytes", number(shortfall.parse_bytes));
    details.insert("heapBytes", number(shortfall.process_bytes));
    details.insert("youngHeapBytes", number(0));
    details.insert("reservedBytes", number(shortfall.reserved_bytes));
    details.insert("blockBytes", number(shortfall.block_bytes));
    details.insert("collectedGarbage", Value::Bool(shortfall.released_pages));
    ServerError::new(status, code, message).with_details(details)
}

pub(crate) fn parse_refusal(engine: &Narsil, raw: &[u8], kind: ParseKind) -> Option<ServerError> {
    let worst_bytes = (raw.len() as u64).saturating_mul(PARSE_WORST_BYTES_PER_BODY_BYTE);
    engine
        .admit_parse(worst_bytes, || scanned_parse_bytes(raw), kind)
        .err()
        .map(|shortfall| refusal_of(raw.len(), &shortfall))
}

fn kind_of(route: Route) -> ParseKind {
    match route {
        Route::List | Route::MultiGet | Route::Search | Route::Preflight | Route::Suggest => {
            ParseKind::Read
        }
        _ => ParseKind::Write,
    }
}

pub(crate) fn route_parse_refusal(
    engine: &Narsil,
    route: Route,
    body: Option<&Bytes>,
) -> Option<ServerError> {
    let raw = body.filter(|raw| !raw.is_empty())?;
    parse_refusal(engine, raw, kind_of(route))
}

pub(crate) async fn body_parse_refusal(
    engine: &Arc<Narsil>,
    route: Route,
    body: Option<&Bytes>,
) -> Option<ServerError> {
    let raw = body.filter(|raw| !raw.is_empty())?.clone();
    let engine = Arc::clone(engine);
    tokio::task::spawn_blocking(move || route_parse_refusal(&engine, route, Some(&raw)))
        .await
        .unwrap_or_else(|_| Some(ServerError::internal()))
}
