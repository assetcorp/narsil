use std::sync::Arc;
use std::time::Duration;

use http::uri::PathAndQuery;
use narsil::Value;
use tokio_rustls::rustls::ClientConfig;
use tonic::{Code, Request, Status};
use tonic_prost::ProstCodec;

use super::envelope::{
    Chunk, Envelope, MAX_GRPC_MESSAGE_BYTES, OPEN_STREAM_METHOD_PATH, SEND_METHOD_PATH,
};
use super::peer_channel::{Http2Channel, PeerChannel, connect_failed};
use crate::constants::MAX_MESSAGE_SIZE_BYTES;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, decode_message, encode_message, encoded_message_len};
use crate::transport::peers::Peers;
use crate::transport::run_handler::call_chunk_handler;
use crate::transport::{ChunkHandler, TransportConfig};

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
    peers: Peers<PeerChannel>,
}

impl GrpcPool {
    pub(crate) fn new(timeouts: TransportConfig, tls: Option<Arc<ClientConfig>>) -> GrpcPool {
        GrpcPool {
            timeouts,
            tls,
            peers: Peers::new("gRPC client pool has been shut down"),
        }
    }

    async fn client(&self, target: &str) -> ClusterResult<tonic::client::Grpc<Http2Channel>> {
        let peer = self
            .peers
            .link(target, || {
                PeerChannel::open(
                    target.to_string(),
                    self.tls.clone(),
                    self.timeouts.connect_timeout,
                )
            })
            .await?;
        Ok(tonic::client::Grpc::with_origin(peer.channel, peer.origin)
            .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES))
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
        self.peers.shut_down().await;
    }
}
