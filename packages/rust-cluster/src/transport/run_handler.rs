use std::panic::AssertUnwindSafe;

use bytes::Bytes;

use super::{ChunkHandler, ListenHandler, Respond};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;

pub(crate) async fn run_handler(
    handler: ListenHandler,
    message: TransportMessage,
    respond: Respond,
) -> Result<(), String> {
    match tokio::spawn(handler(message, respond)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.message().to_string()),
        Err(_) => Err("The listener failed while it handled the request".to_string()),
    }
}

pub(crate) fn call_chunk_handler(handler: &mut ChunkHandler, chunk: Bytes) -> ClusterResult<()> {
    std::panic::catch_unwind(AssertUnwindSafe(|| handler(chunk))).unwrap_or_else(|_| {
        Err(ClusterError::new(
            codes::INTERNAL_ERROR,
            "The stream chunk handler panicked",
        ))
    })
}
