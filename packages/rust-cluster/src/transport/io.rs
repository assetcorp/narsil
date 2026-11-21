use std::sync::Arc;
use std::time::Duration;

use narsil::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::rustls::{ClientConfig, ServerConfig};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::address::parse_address;
use super::tls::server_name;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) trait PeerIo: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> PeerIo for T {}

pub(crate) type PeerStream = Box<dyn PeerIo>;

fn connect_failed(target: &str, reason: String) -> ClusterError {
    ClusterError::new(
        codes::TRANSPORT_CONNECT_FAILED,
        format!("Failed to connect to '{target}': {reason}"),
    )
    .with_detail("target", Value::String(target.to_string()))
}

async fn open(target: &str, tls: Option<Arc<ClientConfig>>) -> ClusterResult<PeerStream> {
    let address = parse_address(target)?;
    let socket = TcpStream::connect((address.host.as_str(), address.port))
        .await
        .map_err(|error| connect_failed(target, error.to_string()))?;
    let _ = socket.set_nodelay(true);
    let Some(tls) = tls else {
        return Ok(Box::new(socket));
    };
    let name = server_name(&address.host, target)?;
    let stream = TlsConnector::from(tls)
        .connect(name, socket)
        .await
        .map_err(|error| connect_failed(target, error.to_string()))?;
    Ok(Box::new(stream))
}

pub(crate) async fn connect(
    target: &str,
    tls: Option<Arc<ClientConfig>>,
    timeout: Duration,
) -> ClusterResult<PeerStream> {
    match tokio::time::timeout(timeout, open(target, tls)).await {
        Ok(result) => result,
        Err(_) => Err(connect_failed(
            target,
            format!("no connection was ready within {}ms", timeout.as_millis()),
        )
        .with_detail("timeoutMs", Value::Number(timeout.as_millis() as f64))),
    }
}

pub(crate) async fn accept(
    socket: TcpStream,
    tls: Option<Arc<ServerConfig>>,
    handshake_timeout: Duration,
) -> Option<PeerStream> {
    let _ = socket.set_nodelay(true);
    let Some(tls) = tls else {
        return Some(Box::new(socket));
    };
    match tokio::time::timeout(handshake_timeout, TlsAcceptor::from(tls).accept(socket)).await {
        Ok(Ok(stream)) => Some(Box::new(stream)),
        _ => None,
    }
}
