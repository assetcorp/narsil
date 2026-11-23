use std::sync::Arc;

use bytes::Bytes;
use narsil::SyncSnapshot;

use super::errors::preparing;
use super::range::{RangeAnswer, range_of};
use super::stream::{Chunk, ChunkBody, ChunkSender, chunk_channel, deliver};
use crate::constants::{RESPONSE_STREAM_CHUNK_BYTES, SNAPSHOT_ARCHIVE_CONTENT_TYPE};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::handlers::common::engine_call;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, empty, insert_header, with_body};
use crate::state::ServerState;

pub(crate) const SYNC_SNAPSHOT_PREPARING: &str = "SYNC_SNAPSHOT_PREPARING";
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

pub(crate) trait SnapshotDownload: Send + Sync + 'static {
    fn entity_tag(&self) -> &str;
    fn byte_length(&self) -> u64;
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> narsil::Result<usize>;
}

impl SnapshotDownload for SyncSnapshot {
    fn entity_tag(&self) -> &str {
        SyncSnapshot::entity_tag(self)
    }

    fn byte_length(&self) -> u64 {
        SyncSnapshot::byte_length(self)
    }

    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> narsil::Result<usize> {
        SyncSnapshot::read_at(self, offset, buffer)
    }
}

#[cfg(feature = "cluster")]
impl SnapshotDownload for narsil_cluster::node::ClusterSyncSnapshot {
    fn entity_tag(&self) -> &str {
        narsil_cluster::node::ClusterSyncSnapshot::entity_tag(self)
    }

    fn byte_length(&self) -> u64 {
        narsil_cluster::node::ClusterSyncSnapshot::byte_length(self)
    }

    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> narsil::Result<usize> {
        narsil_cluster::node::ClusterSyncSnapshot::read_at(self, offset, buffer)
    }
}

fn read_chunk(
    snapshot: &dyn SnapshotDownload,
    from: u64,
    end_exclusive: u64,
) -> narsil::Result<Bytes> {
    let mut buffer = vec![0u8; chunk_length(from, end_exclusive)];
    let read = snapshot.read_at(from, &mut buffer)?;
    buffer.truncate(read);
    Ok(Bytes::from(buffer))
}

async fn send_rest(
    snapshot: Arc<dyn SnapshotDownload>,
    sender: ChunkSender,
    mut from: u64,
    end_exclusive: u64,
) {
    while from < end_exclusive {
        let reader = Arc::clone(&snapshot);
        let read =
            tokio::task::spawn_blocking(move || read_chunk(reader.as_ref(), from, end_exclusive))
                .await;
        let chunk = match read {
            Ok(Ok(chunk)) if !chunk.is_empty() => chunk,
            _ => return,
        };
        from = from.saturating_add(chunk.len() as u64);
        if !deliver(&sender, Chunk::Data(chunk)).await {
            return;
        }
    }
    deliver(&sender, Chunk::End).await;
}

fn refused_range(length: u64, entity_tag: &str) -> HttpResponse {
    let mut response = empty(416);
    insert_header(&mut response, "content-range", &format!("bytes */{length}"));
    insert_header(&mut response, "etag", &quoted(entity_tag));
    insert_header(&mut response, "cache-control", NO_STORE);
    response
}

pub(crate) fn require_sync_feed(state: &ServerState) -> Outcome<()> {
    if state.feeds.sync.is_none() {
        return Err(ServerError::new(
            404,
            server_codes::NOT_FOUND,
            "Route not found",
        ));
    }
    Ok(())
}

pub(crate) async fn sync_snapshot(
    state: &Arc<ServerState>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    require_sync_feed(state)?;
    let wanted = context.param(0).to_string();
    let snapshot = engine_call(state, move |engine| engine.sync_snapshot(&wanted))
        .await
        .map_err(|failure| preparing(failure, SYNC_SNAPSHOT_PREPARING))?;
    serve_snapshot(context, Arc::new(snapshot)).await
}

pub(crate) async fn serve_snapshot(
    context: &RouteContext,
    snapshot: Arc<dyn SnapshotDownload>,
) -> Outcome<HttpResponse> {
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
    let first =
        tokio::task::spawn_blocking(move || read_chunk(reader.as_ref(), start, end_exclusive))
            .await
            .map_err(|_| ServerError::internal())?
            .map_err(ServerError::from)?;
    if first.is_empty() && start < end_exclusive {
        return Err(ServerError::internal());
    }
    let (sender, receiver) = chunk_channel();
    let after_first = start.saturating_add(first.len() as u64);
    tokio::spawn(send_rest(snapshot, sender, after_first, end_exclusive));
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
