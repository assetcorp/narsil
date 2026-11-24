#![cfg(target_os = "linux")]

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use narsil_cluster::node::not_ready_handler;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use tokio::runtime::Runtime;

const NODE_ID: &str = "node-under-reconnect";
const RECONNECTING_PEERS: usize = 600;
const HANDSHAKE_WAIT: Duration = Duration::from_secs(1);

fn paused_runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the runtime starts")
}

fn connect_until_refused(port: u16) -> usize {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut connected = Vec::with_capacity(RECONNECTING_PEERS);
    for _ in 0..RECONNECTING_PEERS {
        match TcpStream::connect_timeout(&address, HANDSHAKE_WAIT) {
            Ok(stream) => connected.push(stream),
            Err(_) => break,
        }
    }
    connected.len()
}

#[test]
fn the_tcp_transport_holds_every_peer_of_a_reconnect_burst_while_it_is_busy() {
    let runtime = paused_runtime();
    let transport = TcpTransport::new(
        NODE_ID,
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the transport accepts a plain configuration");
    runtime
        .block_on(transport.listen(not_ready_handler(NODE_ID)))
        .expect("the transport listens");

    let connected = connect_until_refused(transport.port());

    assert_eq!(
        connected, RECONNECTING_PEERS,
        "the system held only {connected} of {RECONNECTING_PEERS} peer connections for a transport that had not accepted them yet"
    );
    runtime.block_on(transport.shutdown());
}

#[test]
fn the_grpc_transport_holds_every_peer_of_a_reconnect_burst_while_it_is_busy() {
    let runtime = paused_runtime();
    let transport = GrpcTransport::new(
        NODE_ID,
        GrpcTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..GrpcTransportConfig::default()
        },
    )
    .expect("the transport accepts a plain configuration");
    runtime
        .block_on(transport.listen(not_ready_handler(NODE_ID)))
        .expect("the transport listens");

    let connected = connect_until_refused(transport.port());

    assert_eq!(
        connected, RECONNECTING_PEERS,
        "the system held only {connected} of {RECONNECTING_PEERS} peer connections for a transport that had not accepted them yet"
    );
    runtime.block_on(transport.shutdown());
}
