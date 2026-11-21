mod client;
mod connection;
mod frame;
mod server;

use std::sync::atomic::{AtomicBool, Ordering};

use narsil::Value;

use self::client::TcpPool;
use self::server::serve_connection;
use super::serve::{ListenSettings, Listener};
use super::tls::tls_contexts;
use super::{
    BoxFuture, ChunkHandler, ListenHandler, Listening, NodeTransport, TlsConfig, TransportConfig,
};
use crate::constants::{DEFAULT_MAX_CONNECTIONS, DEFAULT_TCP_PORT};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;

/// How the TCP transport listens and dials.
#[derive(Debug, Clone)]
pub struct TcpTransportConfig {
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

impl Default for TcpTransportConfig {
    fn default() -> TcpTransportConfig {
        TcpTransportConfig {
            host: "0.0.0.0".to_string(),
            port: DEFAULT_TCP_PORT,
            timeouts: TransportConfig::default(),
            max_connections: DEFAULT_MAX_CONNECTIONS,
            tls: None,
        }
    }
}

/// The TCP transport that a cluster node reaches its peers through, sending length-prefixed MessagePack frames
/// with optional mutual TLS, byte for byte as the TypeScript transport sends them.
pub struct TcpTransport {
    node_id: String,
    timeouts: TransportConfig,
    pool: TcpPool,
    listener: Listener,
    closed: AtomicBool,
}

impl TcpTransport {
    /// Returns a transport for the node `node_id` that listens and dials as `config` describes.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where `config.tls` holds a certificate, a key, or an authority that cannot be
    /// parsed or used.
    pub fn new(
        node_id: impl Into<String>,
        config: TcpTransportConfig,
    ) -> ClusterResult<TcpTransport> {
        let contexts = config
            .tls
            .as_ref()
            .map(|tls| tls_contexts(tls, false))
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
        Ok(TcpTransport {
            node_id: node_id.into(),
            timeouts: config.timeouts,
            pool: TcpPool::new(config.timeouts, client_tls),
            listener: Listener::new(settings, server_tls),
            closed: AtomicBool::new(false),
        })
    }

    /// Returns the port that the listener bound, or 0 before the first call to `listen`.
    pub fn port(&self) -> u16 {
        self.listener.port()
    }

    /// Replaces the certificate material for every connection that opens from now on, leaving open connections as
    /// they are.
    ///
    /// # Errors
    ///
    /// Fails with `TRANSPORT_CONNECT_FAILED` after shutdown, with `TRANSPORT_PEER_UNAVAILABLE` where the transport
    /// started without TLS, and with `CONFIG_INVALID` where `tls` cannot be parsed or used.
    pub fn rotate_tls(&self, tls: &TlsConfig) -> ClusterResult<()> {
        self.ensure_open()?;
        let mut server = self
            .listener
            .tls
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if server.is_none() {
            return Err(ClusterError::new(
                codes::TRANSPORT_PEER_UNAVAILABLE,
                "Cannot rotate TLS context on a server that was started without TLS",
            ));
        }
        let contexts = tls_contexts(tls, false)?;
        *server = Some(contexts.server);
        self.pool.update_tls(contexts.client);
        Ok(())
    }

    fn ensure_open(&self) -> ClusterResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!(
                    "TCP transport for node '{}' has been shut down",
                    self.node_id
                ),
            )
            .with_detail("nodeId", Value::String(self.node_id.clone())));
        }
        Ok(())
    }
}

impl NodeTransport for TcpTransport {
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
            let listening = self.listener.listen(handler, serve_connection).await?;
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
