mod client;
mod envelope;
mod server;

use std::sync::atomic::{AtomicBool, Ordering};

use narsil::Value;

use self::client::GrpcPool;
use self::server::serve_connection;
use super::serve::{ListenSettings, Listener};
use super::tls::tls_contexts;
use super::{
    BoxFuture, ChunkHandler, ListenHandler, Listening, NodeTransport, TlsConfig, TransportConfig,
};
use crate::constants::{DEFAULT_GRPC_PORT, DEFAULT_MAX_CONNECTIONS};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;

/// How the gRPC transport listens and dials.
#[derive(Debug, Clone)]
pub struct GrpcTransportConfig {
    /// The host that the transport listens on.
    pub host: String,
    /// The port that the transport listens on, where 0 asks the system for a free one.
    pub port: u16,
    /// The timeouts that the transport enforces.
    pub timeouts: TransportConfig,
    /// The most inbound connections that the listener holds open at once.
    pub max_connections: usize,
    /// The certificate material that makes every connection mutual TLS, where present.
    pub tls: Option<TlsConfig>,
}

impl Default for GrpcTransportConfig {
    fn default() -> GrpcTransportConfig {
        GrpcTransportConfig {
            host: "0.0.0.0".to_string(),
            port: DEFAULT_GRPC_PORT,
            timeouts: TransportConfig::default(),
            max_connections: DEFAULT_MAX_CONNECTIONS,
            tls: None,
        }
    }
}

/// The gRPC transport that a cluster node reaches its peers through, serving the
/// `narsil.transport.v1.NodeTransport` service of the specification over HTTP/2 with optional mutual TLS.
///
/// Each call carries one MessagePack message inside a protobuf envelope, byte for byte as the TypeScript transport
/// sends it.
pub struct GrpcTransport {
    node_id: String,
    timeouts: TransportConfig,
    pool: GrpcPool,
    listener: Listener,
    closed: AtomicBool,
}

impl GrpcTransport {
    /// Returns a transport for the node `node_id` that listens and dials as `config` describes.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where `config.tls` holds a certificate, a key, or an authority that cannot be
    /// parsed or used.
    pub fn new(
        node_id: impl Into<String>,
        config: GrpcTransportConfig,
    ) -> ClusterResult<GrpcTransport> {
        let contexts = config
            .tls
            .as_ref()
            .map(|tls| tls_contexts(tls, true))
            .transpose()?;
        let (server_tls, client_tls) = match contexts {
            Some(contexts) => (Some(contexts.server), Some(contexts.client)),
            None => (None, None),
        };
        let settings = ListenSettings {
            host: config.host,
            port: config.port,
            max_connections: config.max_connections,
            handshake_timeout: config.timeouts.connect_timeout,
        };
        Ok(GrpcTransport {
            node_id: node_id.into(),
            timeouts: config.timeouts,
            pool: GrpcPool::new(config.timeouts, client_tls),
            listener: Listener::new(settings, server_tls),
            closed: AtomicBool::new(false),
        })
    }

    /// Returns the port that the listener bound, or 0 before the first call to `listen`.
    pub fn port(&self) -> u16 {
        self.listener.port()
    }

    fn ensure_open(&self) -> ClusterResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!(
                    "gRPC transport for node '{}' has been shut down",
                    self.node_id
                ),
            )
            .with_detail("nodeId", Value::String(self.node_id.clone())));
        }
        Ok(())
    }
}

impl NodeTransport for GrpcTransport {
    fn send<'a>(
        &'a self,
        target: &'a str,
        message: TransportMessage,
    ) -> BoxFuture<'a, ClusterResult<TransportMessage>> {
        Box::pin(async move {
            self.ensure_open()?;
            self.pool.send(target, message).await
        })
    }

    fn stream<'a>(
        &'a self,
        target: &'a str,
        message: TransportMessage,
        handler: ChunkHandler,
    ) -> BoxFuture<'a, ClusterResult<()>> {
        Box::pin(async move {
            self.ensure_open()?;
            self.pool.stream(target, message, handler).await
        })
    }

    fn listen(&self, handler: ListenHandler) -> BoxFuture<'_, ClusterResult<Listening>> {
        Box::pin(async move {
            self.ensure_open()?;
            let request_timeout = self.timeouts.request_timeout;
            let serve = move |handlers, stream, shutdown| {
                serve_connection(handlers, stream, shutdown, request_timeout)
            };
            let listening = self.listener.listen(handler, serve).await?;
            if self.closed.load(Ordering::Acquire) {
                self.listener.close();
            }
            self.ensure_open()?;
            Ok(listening)
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.closed.swap(true, Ordering::AcqRel) {
                return;
            }
            self.listener.close();
            self.pool.shutdown().await;
        })
    }

    fn timeouts(&self) -> TransportConfig {
        self.timeouts
    }
}
