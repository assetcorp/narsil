use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncWriteExt, WriteHalf};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};

use super::frame::{
    FRAME_TYPE_REQUEST, FRAME_TYPE_RESPONSE, FRAME_TYPE_STREAM_CHUNK, FRAME_TYPE_STREAM_END, Frame,
    FrameData, encode_frame, read_frame,
};
use crate::constants::{MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, OUTBOUND_FRAME_QUEUE_LENGTH};
use crate::message::{TransportMessage, carrier_error, decode_message};
use crate::transport::BoxFuture;
use crate::transport::handler::{ReplySink, Respond};
use crate::transport::io::PeerStream;
use crate::transport::listener::HandlerSlot;
use crate::transport::run_handler::run_handler;

pub(crate) struct Outbound {
    pub(crate) bytes: Vec<u8>,
    pub(crate) written: Option<oneshot::Sender<bool>>,
}

pub(crate) async fn write_frames(
    mut writer: WriteHalf<PeerStream>,
    mut queue: mpsc::Receiver<Outbound>,
) {
    while let Some(outbound) = queue.recv().await {
        let written =
            writer.write_all(&outbound.bytes).await.is_ok() && writer.flush().await.is_ok();
        if let Some(done) = outbound.written {
            let _ = done.send(written);
        }
        if !written {
            break;
        }
    }
    let _ = writer.shutdown().await;
}

pub(crate) async fn queue_frame(queue: &mpsc::Sender<Outbound>, bytes: Vec<u8>) -> bool {
    let (written, done) = oneshot::channel();
    let outbound = Outbound {
        bytes,
        written: Some(written),
    };
    if queue.send(outbound).await.is_err() {
        return false;
    }
    done.await.unwrap_or(false)
}

fn carrier_error_frame(request_id: &str, text: &str) -> Option<Vec<u8>> {
    let message = carrier_error(request_id, text);
    encode_frame(
        FRAME_TYPE_RESPONSE,
        request_id,
        FrameData::Message(&message),
    )
    .ok()
}

struct TcpReplySink {
    frame_request_id: String,
    queue: mpsc::Sender<Outbound>,
    responses: AtomicUsize,
}

impl TcpReplySink {
    fn encode(&self, message: &TransportMessage, first: bool) -> Option<Vec<u8>> {
        let id = &self.frame_request_id;
        let encoded = if first {
            encode_frame(FRAME_TYPE_RESPONSE, id, FrameData::Message(message))
        } else {
            encode_frame(
                FRAME_TYPE_STREAM_CHUNK,
                id,
                FrameData::Bytes(&message.payload),
            )
        };
        match encoded {
            Ok(frame) => Some(frame),
            Err(error) => carrier_error_frame(id, error.message()),
        }
    }
}

impl ReplySink for TcpReplySink {
    fn reply(&self, message: TransportMessage) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let first = self.responses.fetch_add(1, Ordering::AcqRel) == 0;
            if let Some(frame) = self.encode(&message, first) {
                queue_frame(&self.queue, frame).await;
            }
        })
    }
}

async fn answer_request(frame: Frame, handlers: Arc<HandlerSlot>, queue: mpsc::Sender<Outbound>) {
    let Some(handler) = handlers.current() else {
        return;
    };
    let message = match decode_message(&frame.data) {
        Ok(message) => message,
        Err(error) => {
            if let Some(reply) = carrier_error_frame(&frame.request_id, error.message()) {
                queue_frame(&queue, reply).await;
            }
            return;
        }
    };
    let sink = Arc::new(TcpReplySink {
        frame_request_id: frame.request_id,
        queue: queue.clone(),
        responses: AtomicUsize::new(0),
    });
    let outcome = run_handler(handler, message, Respond::new(sink.clone())).await;
    let frame_request_id = &sink.frame_request_id;
    let closing = match outcome {
        Ok(()) if sink.responses.load(Ordering::Acquire) > 0 => encode_frame(
            FRAME_TYPE_STREAM_END,
            frame_request_id,
            FrameData::Bytes(&[]),
        )
        .ok(),
        Ok(()) => None,
        Err(text) => carrier_error_frame(frame_request_id, &text),
    };
    if let Some(bytes) = closing {
        queue_frame(&queue, bytes).await;
    }
}

pub(crate) fn serve_connection(
    handlers: Arc<HandlerSlot>,
    stream: PeerStream,
    mut shutdown: watch::Receiver<bool>,
) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let (mut reader, writer) = tokio::io::split(stream);
        let (queue, outbound) = mpsc::channel(OUTBOUND_FRAME_QUEUE_LENGTH);
        let writing = tokio::spawn(write_frames(writer, outbound));
        let in_flight = Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION));
        loop {
            let frame = tokio::select! {
                frame = read_frame(&mut reader) => frame,
                _ = shutdown.wait_for(|stopped| *stopped) => break,
            };
            let Ok(frame) = frame else {
                break;
            };
            if frame.frame_type != FRAME_TYPE_REQUEST {
                continue;
            }
            let permit = tokio::select! {
                permit = Arc::clone(&in_flight).acquire_owned() => permit,
                _ = shutdown.wait_for(|stopped| *stopped) => break,
            };
            let Ok(permit) = permit else {
                break;
            };
            let handlers = Arc::clone(&handlers);
            let queue = queue.clone();
            tokio::spawn(async move {
                answer_request(frame, handlers, queue).await;
                drop(permit);
            });
        }
        writing.abort();
    })
}
