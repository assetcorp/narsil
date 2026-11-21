use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use http::uri::PathAndQuery;
use hyper::body::Incoming;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use narsil::Value;
use tokio::task::AbortHandle;
use tokio_rustls::rustls::ClientConfig;
use tonic::{Code, Request, Status};
use tonic_prost::ProstCodec;

use super::envelope::{
    Chunk, Envelope, MAX_GRPC_MESSAGE_BYTES, OPEN_STREAM_METHOD_PATH, SEND_METHOD_PATH,
};
use crate::constants::{GRPC_KEEPALIVE_TIME_MS, GRPC_KEEPALIVE_TIMEOUT_MS, MAX_MESSAGE_SIZE_BYTES};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, decode_message, encode_message, encoded_message_len};
use crate::transport::io::connect;
use crate::transport::run_handler::call_chunk_handler;
use crate::transport::{BoxFuture, ChunkHandler, TransportConfig};

type Body = tonic::body::Body;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
struct Http2Channel(SendRequest<Body>);

impl tower_service::Service<http::Request<Body>> for Http2Channel {
    type Response = http::Response<Incoming>;
    type Error = hyper::Error;
    type Future = BoxFuture<'static, Result<http::Response<Incoming>, hyper::Error>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), hyper::Error>> {
        self.0.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        Box::pin(self.0.send_request(request))
    }
}

struct Peer {
    channel: Http2Channel,
    origin: Uri,
    driver: AbortHandle,
}

type Slot = Arc<tokio::sync::Mutex<Option<Peer>>>;

fn call_details(error: ClusterError, target: &str, request_id: &str) -> ClusterError {
    error
        .with_detail("target", Value::String(target.to_string()))
        .with_detail("requestId", Value::String(request_id.to_string()))
}

fn map_status(target: &str, request_id: &str, status: &Status) -> ClusterError {
    let text = status.message();
    let error = match status.code() {
        Code::DeadlineExceeded => ClusterError::new(
            codes::TRANSPORT_TIMEOUT,
            format!("Request to '{target}' timed out: {text}"),
        ),
        Code::ResourceExhausted | Code::OutOfRange => ClusterError::new(
            codes::TRANSPORT_MESSAGE_TOO_LARGE,
            format!("Message to '{target}' exceeded a size limit: {text}"),
        ),
        _ => ClusterError::new(
            codes::TRANSPORT_PEER_UNAVAILABLE,
            format!("Request to '{target}' failed: {text}"),
        ),
    };
    call_details(error, target, request_id)
}

fn connect_failed(target: &str, reason: String) -> ClusterError {
    ClusterError::new(
        codes::TRANSPORT_CONNECT_FAILED,
        format!("Failed to connect to '{target}': {reason}"),
    )
    .with_detail("target", Value::String(target.to_string()))
}

fn timed_out(target: &str, request_id: &str, timeout: Duration, message: String) -> ClusterError {
    call_details(
        ClusterError::new(codes::TRANSPORT_TIMEOUT, message),
        target,
        request_id,
    )
    .with_detail("timeoutMs", Value::Number(timeout.as_millis() as f64))
}

fn checked_envelope(target: &str, message: &TransportMessage) -> ClusterResult<Envelope> {
    let size = encoded_message_len(message);
    if size > MAX_MESSAGE_SIZE_BYTES {
        return Err(call_details(
            ClusterError::new(
                codes::TRANSPORT_MESSAGE_TOO_LARGE,
                format!(
                    "Message payload ({size} bytes) exceeds the {MAX_MESSAGE_SIZE_BYTES} byte limit"
                ),
            ),
            target,
            &message.request_id,
        )
        .with_detail("payloadSize", Value::Number(size as f64)));
    }
    Ok(Envelope {
        message: encode_message(message).into(),
    })
}

pub(crate) struct GrpcPool {
    timeouts: TransportConfig,
    tls: Option<Arc<ClientConfig>>,
    slots: Mutex<HashMap<String, Slot>>,
    closed: AtomicBool,
}

impl GrpcPool {
    pub(crate) fn new(timeouts: TransportConfig, tls: Option<Arc<ClientConfig>>) -> GrpcPool {
        GrpcPool {
            timeouts,
            tls,
            slots: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn ensure_open(&self) -> ClusterResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                "gRPC client pool has been shut down",
            ));
        }
        Ok(())
    }

    async fn open(&self, target: &str) -> ClusterResult<Peer> {
        let scheme = if self.tls.is_some() { "https" } else { "http" };
        let origin = Uri::try_from(format!("{scheme}://{target}")).map_err(|_| {
            connect_failed(target, "the address is not a host and port".to_string())
                .with_detail("unaddressableTarget", Value::Bool(true))
        })?;
        let stream = connect(target, self.tls.clone(), self.timeouts.connect_timeout).await?;
        let mut builder = hyper::client::conn::http2::Builder::new(TokioExecutor::new());
        builder
            .timer(TokioTimer::new())
            .keep_alive_interval(Duration::from_millis(GRPC_KEEPALIVE_TIME_MS))
            .keep_alive_timeout(Duration::from_millis(GRPC_KEEPALIVE_TIMEOUT_MS))
            .keep_alive_while_idle(true);
        let handshake = builder.handshake::<_, Body>(TokioIo::new(stream));
        let (sender, connection) =
            match tokio::time::timeout(self.timeouts.connect_timeout, handshake).await {
                Ok(Ok(pair)) => pair,
                Ok(Err(error)) => return Err(connect_failed(target, error.to_string())),
                Err(_) => {
                    return Err(connect_failed(
                        target,
                        format!(
                            "no connection was ready within {}ms",
                            self.timeouts.connect_timeout.as_millis()
                        ),
                    ));
                }
            };
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        })
        .abort_handle();
        Ok(Peer {
            channel: Http2Channel(sender),
            origin,
            driver,
        })
    }

    fn prune(&self, keep: &str) {
        lock(&self.slots).retain(|target, slot| {
            target == keep
                || Arc::strong_count(slot) > 1
                || slot.try_lock().map_or(true, |current| {
                    current
                        .as_ref()
                        .is_some_and(|peer| !peer.channel.0.is_closed())
                })
        });
    }

    async fn client(&self, target: &str) -> ClusterResult<tonic::client::Grpc<Http2Channel>> {
        self.ensure_open()?;
        let slot = Arc::clone(lock(&self.slots).entry(target.to_string()).or_default());
        let mut current = slot.lock().await;
        let usable = current
            .as_ref()
            .is_some_and(|peer| !peer.channel.0.is_closed());
        if !usable {
            if let Some(stale) = current.take() {
                stale.driver.abort();
            }
            let peer = self.open(target).await?;
            if self.closed.load(Ordering::Acquire) {
                peer.driver.abort();
                return Err(ClusterError::new(
                    codes::TRANSPORT_CONNECT_FAILED,
                    "gRPC client pool has been shut down",
                ));
            }
            *current = Some(peer);
            self.prune(target);
        }
        let Some(peer) = current.as_ref() else {
            return Err(connect_failed(target, "the channel closed".to_string()));
        };
        Ok(
            tonic::client::Grpc::with_origin(peer.channel.clone(), peer.origin.clone())
                .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
        )
    }

    pub(crate) async fn send(
        &self,
        target: &str,
        message: TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let envelope = checked_envelope(target, &message)?;
        let mut grpc = self.client(target).await?;
        let request_id = message.request_id.as_str();
        let deadline = self.timeouts.reply_deadline(&message.message_type);
        let mut request = Request::new(envelope);
        request.set_timeout(deadline);
        let call = async {
            grpc.ready()
                .await
                .map_err(|error| connect_failed(target, error.to_string()))?;
            grpc.unary(
                request,
                PathAndQuery::from_static(SEND_METHOD_PATH),
                ProstCodec::<Envelope, Envelope>::default(),
            )
            .await
            .map_err(|status| map_status(target, request_id, &status))
        };
        let response = match tokio::time::timeout(deadline, call).await {
            Ok(response) => response?,
            Err(_) => {
                return Err(timed_out(
                    target,
                    request_id,
                    deadline,
                    format!(
                        "Request to '{target}' timed out after {}ms",
                        deadline.as_millis()
                    ),
                ));
            }
        };
        decode_message(&response.into_inner().message).map_err(|error| {
            call_details(
                ClusterError::new(
                    codes::TRANSPORT_DECODE_FAILED,
                    format!("Failed to decode response: {}", error.message()),
                ),
                target,
                request_id,
            )
        })
    }

    pub(crate) async fn stream(
        &self,
        target: &str,
        message: TransportMessage,
        mut handler: ChunkHandler,
    ) -> ClusterResult<()> {
        let envelope = checked_envelope(target, &message)?;
        let mut grpc = self.client(target).await?;
        let request_id = message.request_id.as_str();
        let idle = self.timeouts.snapshot_timeout;
        let idle_error = || {
            timed_out(
                target,
                request_id,
                idle,
                format!(
                    "No chunk of the stream from '{target}' arrived within {}ms",
                    idle.as_millis()
                ),
            )
        };
        let open = async {
            grpc.ready()
                .await
                .map_err(|error| connect_failed(target, error.to_string()))?;
            grpc.server_streaming(
                Request::new(envelope),
                PathAndQuery::from_static(OPEN_STREAM_METHOD_PATH),
                ProstCodec::<Envelope, Chunk>::default(),
            )
            .await
            .map_err(|status| map_status(target, request_id, &status))
        };
        let mut chunks = match tokio::time::timeout(idle, open).await {
            Ok(response) => response?.into_inner(),
            Err(_) => return Err(idle_error()),
        };
        loop {
            let chunk = match tokio::time::timeout(idle, chunks.message()).await {
                Ok(Ok(Some(chunk))) => chunk,
                Ok(Ok(None)) => return Ok(()),
                Ok(Err(status)) => return Err(map_status(target, request_id, &status)),
                Err(_) => return Err(idle_error()),
            };
            call_chunk_handler(&mut handler, chunk.data)?;
        }
    }

    pub(crate) async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let slots: Vec<Slot> = lock(&self.slots).drain().map(|(_, slot)| slot).collect();
        for slot in slots {
            if let Some(peer) = slot.lock().await.take() {
                peer.driver.abort();
            }
        }
    }
}
