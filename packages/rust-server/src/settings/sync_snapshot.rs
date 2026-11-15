use std::sync::Arc;

use bytes::Bytes;
use narsil::SyncSnapshot;

use super::errors::{indexed, preparing};
use super::range::{RangeAnswer, range_of};
use super::stream::{ChunkBody, ChunkSender, chunk_channel, stream_cut_short};
use crate::constants::{RESPONSE_STREAM_CHUNK_BYTES, SNAPSHOT_ARCHIVE_CONTENT_TYPE};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::handlers::common::engine_call;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, empty, insert_header, with_body};
use crate::state::ServerState;

const SYNC_SNAPSHOT_PREPARING: &str = "SYNC_SNAPSHOT_PREPARING";
const NO_STORE: &str = "no-store";
const BYTE_RANGES: &str = "bytes";

fn request_header(context: &RouteContext, name: &str) -> Option<String> {
    let value = context.headers.get(name)?;
    let text = String::from_utf8_lossy(value.as_bytes()).into_owned();
    (!text.is_empty()).then_some(text)
}

fn quoted(entity_tag: &str) -> String {
    format!("\"{entity_tag}\"")
}

fn chunk_length(from: u64, end_exclusive: u64) -> usize {
    let left = end_exclusive.saturating_sub(from);
    usize::try_from(left).map_or(RESPONSE_STREAM_CHUNK_BYTES, |left| {
        left.min(RESPONSE_STREAM_CHUNK_BYTES)
    })
}

fn read_chunk(snapshot: &SyncSnapshot, from: u64, end_exclusive: u64) -> narsil::Result<Bytes> {
    let mut buffer = vec![0u8; chunk_length(from, end_exclusive)];
    let read = snapshot.read_at(from, &mut buffer)?;
    buffer.truncate(read);
    Ok(Bytes::from(buffer))
}

fn send_rest(snapshot: &SyncSnapshot, sender: &ChunkSender, mut from: u64, end_exclusive: u64) {
    while from < end_exclusive {
        let chunk = match read_chunk(snapshot, from, end_exclusive) {
            Ok(chunk) if !chunk.is_empty() => chunk,
            _ => {
                let _ = sender.blocking_send(Err(stream_cut_short()));
                return;
            }
        };
        from = from.saturating_add(chunk.len() as u64);
        if sender.blocking_send(Ok(chunk)).is_err() {
            return;
        }
    }
}

fn refused_range(length: u64, entity_tag: &str) -> HttpResponse {
    let mut response = empty(416);
    insert_header(&mut response, "content-range", &format!("bytes */{length}"));
    insert_header(&mut response, "etag", &quoted(entity_tag));
    insert_header(&mut response, "cache-control", NO_STORE);
    response
}

pub(crate) async fn sync_snapshot(
    state: &Arc<ServerState>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    if state.feeds.sync.is_none() {
        return Err(ServerError::new(
            404,
            server_codes::NOT_FOUND,
            "Route not found",
        ));
    }
    let name = context.param(0).to_string();
    let wanted = name.clone();
    let snapshot = engine_call(state, move |engine| engine.sync_snapshot(&wanted))
        .await
        .map_err(|failure| preparing(indexed(failure, &name), SYNC_SNAPSHOT_PREPARING))?;
    let snapshot = Arc::new(snapshot);
    let length = snapshot.byte_length();
    let entity_tag = snapshot.entity_tag().to_string();
    let range = request_header(context, "range");
    let if_range = request_header(context, "if-range");
    let (status, start, end_exclusive) =
        match range_of(range.as_deref(), if_range.as_deref(), &entity_tag, length) {
            RangeAnswer::Unsatisfiable => return Ok(refused_range(length, &entity_tag)),
            RangeAnswer::Whole => (200, 0, length),
            RangeAnswer::Partial {
                start,
                end_exclusive,
            } => (206, start, end_exclusive),
        };
    let reader = Arc::clone(&snapshot);
    let first = tokio::task::spawn_blocking(move || read_chunk(&reader, start, end_exclusive))
        .await
        .map_err(|_| ServerError::internal())?
        .map_err(|failure| indexed(ServerError::from(failure), &name))?;
    if first.is_empty() && start < end_exclusive {
        return Err(ServerError::internal());
    }
    let (sender, receiver) = chunk_channel();
    let after_first = start.saturating_add(first.len() as u64);
    tokio::task::spawn_blocking(move || send_rest(&snapshot, &sender, after_first, end_exclusive));
    let first = (!first.is_empty()).then_some(first);
    let body = ChunkBody::boxed(first, receiver, Some(end_exclusive.saturating_sub(start)));
    let mut response = with_body(status, SNAPSHOT_ARCHIVE_CONTENT_TYPE, body);
    insert_header(&mut response, "etag", &quoted(&entity_tag));
    insert_header(&mut response, "accept-ranges", BYTE_RANGES);
    insert_header(&mut response, "cache-control", NO_STORE);
    if status == 206 {
        let last = end_exclusive.saturating_sub(1);
        insert_header(
            &mut response,
            "content-range",
            &format!("bytes {start}-{last}/{length}"),
        );
    }
    Ok(response)
}
