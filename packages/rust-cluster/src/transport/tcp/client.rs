use std::sync::{Arc, RwLock};
use std::time::Duration;

use narsil::Value;
use tokio::sync::oneshot;
use tokio_rustls::rustls::ClientConfig;

use super::connection::{Connection, StreamWaiter, Waiter, peer_unavailable};
use super::frame::{FRAME_TYPE_REQUEST, FrameData, encode_frame};
use super::server::queue_frame;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::transport::io::connect;
use crate::transport::peers::Peers;
use crate::transport::{ChunkHandler, TransportConfig};

struct Registration<'a> {
    connection: &'a Connection,
    request_id: &'a str,
    ticket: u64,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.connection.release(self.request_id, self.ticket);
    }
}

fn timed_out(target: &str, request_id: &str, timeout: Duration, message: String) -> ClusterError {
    ClusterError::new(codes::TRANSPORT_TIMEOUT, message)
        .with_detail("target", Value::String(target.to_string()))
        .with_detail("requestId", Value::String(request_id.to_string()))
        .with_detail("timeoutMs", Value::Number(timeout.as_millis() as f64))
}

fn write_failed(target: &str, request_id: &str) -> ClusterError {
    peer_unavailable(
        target,
        format!("Failed to write to '{target}': the connection closed"),
    )
    .with_detail("requestId", Value::String(request_id.to_string()))
}

fn closed_before_answer(target: &str) -> ClusterError {
    peer_unavailable(
        target,
        format!("Connection to '{target}' closed before a response was received"),
    )
}

fn request_frame(target: &str, message: &TransportMessage) -> ClusterResult<Vec<u8>> {
    encode_frame(
        FRAME_TYPE_REQUEST,
        &message.request_id,
        FrameData::Message(message),
    )
    .map_err(|error| {
        error
            .with_detail("target", Value::String(target.to_string()))
            .with_detail("requestId", Value::String(message.request_id.clone()))
    })
}

pub(crate) struct TcpPool {
    timeouts: TransportConfig,
    tls: RwLock<Option<Arc<ClientConfig>>>,
    peers: Peers<Arc<Connection>>,
}

impl TcpPool {
    pub(crate) fn new(timeouts: TransportConfig, tls: Option<Arc<ClientConfig>>) -> TcpPool {
        TcpPool {
            timeouts,
            tls: RwLock::new(tls),
            peers: Peers::new("Connection pool has been shut down"),
        }
    }

    pub(crate) fn update_tls(&self, tls: Arc<ClientConfig>) {
        *self
            .tls
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(tls);
    }

    async fn connection(&self, target: &str) -> ClusterResult<Arc<Connection>> {
        self.peers
            .link(target, || {
                let tls = self
                    .tls
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                let timeout = self.timeouts.connect_timeout;
                let target = target.to_string();
                async move {
                    let stream = connect(&target, tls, timeout).await?;
                    Ok(Connection::start(&target, stream))
                }
            })
            .await
    }

    pub(crate) async fn send(
        &self,
        target: &str,
        message: TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        self.peers.ensure_open(target)?;
        let frame = request_frame(target, &message)?;
        let connection = self.connection(target).await?;
        let request_id = message.request_id.as_str();
        let (answer, answered) = oneshot::channel();
        let ticket = connection.register(request_id, Waiter::Request(answer))?;
        let _registration = Registration {
            connection: &connection,
            request_id,
            ticket,
        };
        let deadline = self.timeouts.reply_deadline(&message.message_type);
        let exchange = async {
            if !queue_frame(&connection.queue, frame).await {
                connection.close(closed_before_answer(target));
                return Err(write_failed(target, request_id));
            }
            answered
                .await
                .unwrap_or_else(|_| Err(closed_before_answer(target)))
        };
        match tokio::time::timeout(deadline, exchange).await {
            Ok(result) => result,
            Err(_) => Err(timed_out(
                target,
                request_id,
                deadline,
                format!(
                    "Request to '{target}' timed out after {}ms",
                    deadline.as_millis()
                ),
            )),
        }
    }

    pub(crate) async fn stream(
        &self,
        target: &str,
        message: TransportMessage,
        handler: ChunkHandler,
    ) -> ClusterResult<()> {
        self.peers.ensure_open(target)?;
        let frame = request_frame(target, &message)?;
        let connection = self.connection(target).await?;
        let request_id = message.request_id.as_str();
        let (waiter, finished) = StreamWaiter::new(handler);
        let ticket = connection.register(request_id, Waiter::Stream(Arc::clone(&waiter)))?;
        let _registration = Registration {
            connection: &connection,
            request_id,
            ticket,
        };
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
        match tokio::time::timeout(idle, queue_frame(&connection.queue, frame)).await {
            Ok(true) => {}
            Ok(false) => {
                connection.close(closed_before_answer(target));
                return Err(write_failed(target, request_id));
            }
            Err(_) => return Err(idle_error()),
        }
        tokio::pin!(finished);
        loop {
            let progress = waiter.progress.notified();
            tokio::select! {
                result = &mut finished => {
                    return result.unwrap_or_else(|_| Err(closed_before_answer(target)));
                }
                _ = progress => {}
                _ = tokio::time::sleep(idle) => return Err(idle_error()),
            }
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.peers.shut_down().await;
    }
}
