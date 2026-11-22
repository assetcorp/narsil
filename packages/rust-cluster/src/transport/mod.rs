mod address;
mod handler;
mod io;
mod listener;
mod peers;
mod run_handler;
mod serve;
mod tls;

pub mod grpc;
pub mod tcp;

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;

pub use handler::{ListenHandler, Respond, listen_handler};
pub use listener::Listening;
pub use tls::TlsConfig;

use crate::constants::{
    DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REPLICATION_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_SNAPSHOT_TIMEOUT_MS,
};
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};

/// A boxed future that a transport returns, so that a caller can hold any transport behind `dyn NodeTransport`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Receives each chunk of a streamed answer, in order, and fails the stream by returning an error.
pub type ChunkHandler = Box<dyn FnMut(Bytes) -> ClusterResult<()> + Send>;

/// How long a transport waits on each kind of exchange.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportConfig {
    /// The longest wait to open a connection to a peer.
    pub connect_timeout: Duration,
    /// The longest wait for the answer to a request that `replication_timeout` does not cover.
    pub request_timeout: Duration,
    /// The longest wait for the answer to a `replication.entry`, a `replication.entry_batch`, or a
    /// `replication.term_start`.
    pub replication_timeout: Duration,
    /// The longest wait for the next chunk of a streamed answer.
    pub snapshot_timeout: Duration,
}

impl Default for TransportConfig {
    fn default() -> TransportConfig {
        TransportConfig {
            connect_timeout: Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS),
            request_timeout: Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS),
            replication_timeout: Duration::from_millis(DEFAULT_REPLICATION_TIMEOUT_MS),
            snapshot_timeout: Duration::from_millis(DEFAULT_SNAPSHOT_TIMEOUT_MS),
        }
    }
}

impl TransportConfig {
    /// Returns the wait for the answer to a request of `message_type`.
    pub fn reply_deadline(&self, message_type: &str) -> Duration {
        match message_type {
            message_types::REPLICATION_ENTRY
            | message_types::REPLICATION_ENTRY_BATCH
            | message_types::REPLICATION_TERM_START => self.replication_timeout,
            _ => self.request_timeout,
        }
    }
}

/// How one cluster node reaches the others, as the `NodeTransport` adapter of the specification defines it.
pub trait NodeTransport: Send + Sync {
    /// Sends `message` to the node at `target`, a `host:port` address, and returns its answer.
    ///
    /// # Errors
    ///
    /// Fails with `TRANSPORT_CONNECT_FAILED` where the message never left this node, with
    /// `TRANSPORT_PEER_UNAVAILABLE` where the connection failed after it left, with `TRANSPORT_TIMEOUT` where no
    /// answer arrived in time, with `TRANSPORT_MESSAGE_TOO_LARGE` where a message passes the size limit, and with
    /// `TRANSPORT_DECODE_FAILED` where the answer cannot be decoded.
    fn send<'a>(
        &'a self,
        target: &'a str,
        message: TransportMessage,
    ) -> BoxFuture<'a, ClusterResult<TransportMessage>>;

    /// Sends `message` to the node at `target` and passes each chunk of its streamed answer to `handler`, in order,
    /// returning once the stream ends.
    ///
    /// # Errors
    ///
    /// Fails with the codes of [`NodeTransport::send`], with `TRANSPORT_TIMEOUT` where no chunk arrives within the
    /// snapshot timeout, with `TRANSPORT_PEER_UNAVAILABLE` where the peer's listener fails before its first chunk,
    /// with the error that `handler` returns where it fails, and with `INTERNAL_ERROR` where it panics. A failing
    /// handler ends this stream alone, and the connection keeps serving other requests.
    fn stream<'a>(
        &'a self,
        target: &'a str,
        message: TransportMessage,
        handler: ChunkHandler,
    ) -> BoxFuture<'a, ClusterResult<()>>;

    /// Starts accepting requests and passes each one to `handler`, replacing any handler that an earlier call
    /// registered, and returns the handle that removes it.
    ///
    /// # Errors
    ///
    /// Fails with `TRANSPORT_CONNECT_FAILED` where the listener cannot bind its address or where the transport has
    /// shut down.
    fn listen(&self, handler: ListenHandler) -> BoxFuture<'_, ClusterResult<Listening>>;

    /// Closes every connection and stops listening. A second call does nothing.
    fn shutdown(&self) -> BoxFuture<'_, ()>;

    /// Returns the timeouts that this transport enforces.
    fn timeouts(&self) -> TransportConfig;
}
