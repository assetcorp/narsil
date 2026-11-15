use std::time::Duration;

use bytes::{Bytes, BytesMut};
use http::HeaderMap;
use http::header::CONTENT_LENGTH;
use http_body_util::BodyExt;
use hyper::body::Incoming;

use super::budget::BodyHold;
use super::pace::{BodyPace, NextChunk};
use crate::constants::{REFUSED_BODY_DRAIN_BYTES, REFUSED_BODY_DRAIN_MS};
use crate::errors::{ServerError, server_codes};

const LONGEST_DECLARED_LENGTH_DIGITS: usize = 15;

pub(crate) fn declared_body_bytes(headers: &HeaderMap) -> Option<u64> {
    let text = headers.get(CONTENT_LENGTH)?.to_str().ok()?;
    if text.is_empty()
        || text.len() > LONGEST_DECLARED_LENGTH_DIGITS
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}

pub(crate) fn too_large() -> ServerError {
    ServerError::new(
        413,
        server_codes::PAYLOAD_TOO_LARGE,
        "Request body exceeds the configured size limit",
    )
}

pub(crate) enum BodyRead {
    Complete(Bytes),
    Refused(ServerError),
    Ended,
}

pub(crate) async fn read_body(
    mut body: Incoming,
    max_bytes: u64,
    declared: Option<u64>,
    hold: &mut BodyHold,
) -> BodyRead {
    let reserved = declared.filter(|bytes| *bytes <= max_bytes).unwrap_or(0);
    if let Err(refusal) = hold.grow(reserved) {
        drain_in_background(body);
        return BodyRead::Refused(refusal);
    }
    if declared.is_some_and(|bytes| bytes > max_bytes) {
        drain_in_background(body);
        return BodyRead::Refused(too_large());
    }
    let capacity = usize::try_from(reserved).unwrap_or(0);
    let mut buffer = BytesMut::with_capacity(capacity);
    let mut total: u64 = 0;
    let mut pace = BodyPace::new();
    loop {
        let chunk = match pace.next_chunk(&mut body).await {
            NextChunk::Data(chunk) => chunk,
            NextChunk::End => return BodyRead::Complete(buffer.freeze()),
            NextChunk::Broken => return BodyRead::Ended,
        };
        total = total.saturating_add(chunk.len() as u64);
        if total > max_bytes {
            drain_in_background(body);
            return BodyRead::Refused(too_large());
        }
        if total > hold.bytes()
            && let Err(refusal) = hold.grow(total - hold.bytes())
        {
            drain_in_background(body);
            return BodyRead::Refused(refusal);
        }
        buffer.extend_from_slice(&chunk);
    }
}

pub(crate) fn drain_in_background(mut body: Incoming) {
    tokio::spawn(async move {
        let mut drained: u64 = 0;
        let deadline = tokio::time::sleep(Duration::from_millis(REFUSED_BODY_DRAIN_MS));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                () = &mut deadline => return,
                frame = body.frame() => {
                    let Some(Ok(frame)) = frame else { return };
                    if let Ok(chunk) = frame.into_data() {
                        drained = drained.saturating_add(chunk.len() as u64);
                        if drained > REFUSED_BODY_DRAIN_BYTES {
                            return;
                        }
                    }
                }
            }
        }
    });
}
