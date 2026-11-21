use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_core::Stream;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use tokio::sync::{mpsc, oneshot, watch};
use tonic::server::{Grpc, ServerStreamingService, UnaryService};
use tonic::{Request, Response, Status};
use tonic_prost::ProstCodec;

use super::envelope::{
    Chunk, Envelope, GRPC_TIMEOUT_HEADER, MAX_GRPC_MESSAGE_BYTES, OPEN_STREAM_METHOD_PATH,
    SEND_METHOD_PATH, client_deadline, report_size_limit_as_resource_exhausted, within_limit,
};
use crate::constants::{
    GRPC_KEEPALIVE_TIME_MS, GRPC_KEEPALIVE_TIMEOUT_MS, STREAM_CHUNK_QUEUE_LENGTH,
};
use crate::message::{TransportMessage, carrier_error, decode_message, encode_message};
use crate::transport::BoxFuture;
use crate::transport::handler::{ReplySink, Respond};
use crate::transport::io::PeerStream;
use crate::transport::listener::HandlerSlot;
use crate::transport::run_handler::run_handler;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn no_listener() -> Status {
    Status::unavailable("No listener is registered")
}

fn envelope_of(message: &TransportMessage) -> Envelope {
    Envelope {
        message: encode_message(message).into(),
    }
}

struct FirstReply {
    answer: Mutex<Option<oneshot::Sender<TransportMessage>>>,
}

impl ReplySink for FirstReply {
    fn reply(&self, message: TransportMessage) -> BoxFuture<'_, ()> {
        if let Some(answer) = lock(&self.answer).take() {
            let _ = answer.send(message);
        }
        Box::pin(async {})
    }
}

async fn answer_send(handlers: Arc<HandlerSlot>, request: Envelope) -> Result<Envelope, Status> {
    let handler = handlers.current().ok_or_else(no_listener)?;
    let message = match decode_message(&request.message) {
        Ok(message) => message,
        Err(error) => return Ok(envelope_of(&carrier_error("", error.message()))),
    };
    let request_id = message.request_id.clone();
    let (answer, mut answered) = oneshot::channel();
    let sink = Arc::new(FirstReply {
        answer: Mutex::new(Some(answer)),
    });
    let mut running = tokio::spawn(run_handler(handler, message, Respond::new(sink)));
    let failure = |outcome: Result<Result<(), String>, tokio::task::JoinError>| match outcome {
        Ok(Err(text)) => Some(carrier_error(&request_id, &text)),
        _ => None,
    };
    let reply = tokio::select! {
        reply = &mut answered => match reply {
            Ok(reply) => Some(reply),
            Err(_) => failure(running.await),
        },
        outcome = &mut running => match answered.try_recv() {
            Ok(reply) => Some(reply),
            Err(_) => match failure(outcome) {
                Some(carrier) => Some(carrier),
                None => answered.await.ok(),
            },
        },
    };
    match reply {
        Some(reply) => within_limit(envelope_of(&reply)),
        None => std::future::pending().await,
    }
}

async fn answer_send_by(
    handlers: Arc<HandlerSlot>,
    request: Request<Envelope>,
    request_timeout: Duration,
) -> Result<Envelope, Status> {
    let deadline = request
        .metadata()
        .get(GRPC_TIMEOUT_HEADER)
        .and_then(|value| client_deadline(value.as_bytes()))
        .unwrap_or(request_timeout)
        .min(request_timeout);
    match tokio::time::timeout(deadline, answer_send(handlers, request.into_inner())).await {
        Ok(answer) => answer,
        Err(_) => Err(Status::deadline_exceeded("Deadline exceeded")),
    }
}

struct StreamReplies {
    chunks: Mutex<Option<mpsc::Sender<Result<Chunk, Status>>>>,
    sent: AtomicUsize,
}

impl ReplySink for StreamReplies {
    fn reply(&self, message: TransportMessage) -> BoxFuture<'_, ()> {
        let chunks = lock(&self.chunks).clone();
        Box::pin(async move {
            let Some(chunks) = chunks else {
                return;
            };
            self.sent.fetch_add(1, Ordering::AcqRel);
            let chunk = within_limit(Chunk {
                data: message.payload,
            });
            let _ = chunks.send(chunk).await;
        })
    }
}

pub(crate) struct ChunkStream(mpsc::Receiver<Result<Chunk, Status>>);

impl Stream for ChunkStream {
    type Item = Result<Chunk, Status>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(context)
    }
}

async fn open_stream(handlers: Arc<HandlerSlot>, request: Envelope) -> Result<ChunkStream, Status> {
    let handler = handlers.current().ok_or_else(no_listener)?;
    let message = decode_message(&request.message)
        .map_err(|error| Status::invalid_argument(error.message()))?;
    let (chunks, receiver) = mpsc::channel(STREAM_CHUNK_QUEUE_LENGTH);
    let sink = Arc::new(StreamReplies {
        chunks: Mutex::new(Some(chunks)),
        sent: AtomicUsize::new(0),
    });
    let respond = Respond::new(Arc::clone(&sink) as Arc<dyn ReplySink>);
    tokio::spawn(async move {
        let outcome = run_handler(handler, message, respond).await;
        let Some(chunks) = lock(&sink.chunks).take() else {
            return;
        };
        let failure = match outcome {
            Ok(()) if sink.sent.load(Ordering::Acquire) > 0 => return,
            Ok(()) => Status::unknown("The stream handler produced no chunks"),
            Err(text) => Status::unknown(text),
        };
        let _ = chunks.send(Err(failure)).await;
    });
    Ok(ChunkStream(receiver))
}

#[derive(Clone)]
struct SendCall {
    handlers: Arc<HandlerSlot>,
    request_timeout: Duration,
}

impl UnaryService<Envelope> for SendCall {
    type Response = Envelope;
    type Future = BoxFuture<'static, Result<Response<Envelope>, Status>>;

    fn call(&mut self, request: Request<Envelope>) -> Self::Future {
        let handlers = Arc::clone(&self.handlers);
        let request_timeout = self.request_timeout;
        Box::pin(async move {
            answer_send_by(handlers, request, request_timeout)
                .await
                .map(Response::new)
        })
    }
}

#[derive(Clone)]
struct OpenStreamCall(Arc<HandlerSlot>);

impl ServerStreamingService<Envelope> for OpenStreamCall {
    type Response = Chunk;
    type ResponseStream = ChunkStream;
    type Future = BoxFuture<'static, Result<Response<ChunkStream>, Status>>;

    fn call(&mut self, request: Request<Envelope>) -> Self::Future {
        let handlers = Arc::clone(&self.0);
        Box::pin(async move {
            open_stream(handlers, request.into_inner())
                .await
                .map(Response::new)
        })
    }
}

fn grpc<T, U>() -> Grpc<ProstCodec<T, U>>
where
    T: prost::Message + Send + 'static,
    U: prost::Message + Default + Send + 'static,
{
    Grpc::new(ProstCodec::default())
        .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES)
}

async fn route(
    handlers: Arc<HandlerSlot>,
    request: http::Request<Incoming>,
    request_timeout: Duration,
) -> Result<http::Response<tonic::body::Body>, Infallible> {
    let response = match request.uri().path() {
        SEND_METHOD_PATH => {
            let call = SendCall {
                handlers,
                request_timeout,
            };
            grpc::<Envelope, Envelope>().unary(call, request).await
        }
        OPEN_STREAM_METHOD_PATH => {
            grpc::<Chunk, Envelope>()
                .server_streaming(OpenStreamCall(handlers), request)
                .await
        }
        _ => Status::unimplemented("").into_http(),
    };
    Ok(report_size_limit_as_resource_exhausted(response))
}

pub(crate) fn serve_connection(
    handlers: Arc<HandlerSlot>,
    stream: PeerStream,
    mut shutdown: watch::Receiver<bool>,
    request_timeout: Duration,
) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let service =
            service_fn(move |request| route(Arc::clone(&handlers), request, request_timeout));
        let mut builder = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
        builder
            .timer(TokioTimer::new())
            .keep_alive_interval(Duration::from_millis(GRPC_KEEPALIVE_TIME_MS))
            .keep_alive_timeout(Duration::from_millis(GRPC_KEEPALIVE_TIMEOUT_MS));
        let connection = builder.serve_connection(TokioIo::new(stream), service);
        tokio::select! {
            _ = connection => {}
            _ = shutdown.wait_for(|stopped| *stopped) => {}
        }
    })
}
