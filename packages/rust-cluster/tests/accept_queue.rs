#![cfg(target_os = "linux")]

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use narsil_cluster::node::not_ready_handler;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use tokio::runtime::Runtime;

const NODE_ID: &str = "node-under-reconnect";
const RECONNECTING_PEERS: usize = 256;
const HANDSHAKE_WAIT: Duration = Duration::from_secs(1);

fn reconnecting_peers() -> usize {
    let system_limit: usize = std::fs::read_to_string("/proc/sys/net/core/somaxconn")
        .expect("the system reports its accept queue limit")
        .trim()
        .parse()
        .expect("the accept queue limit is a whole number");
    RECONNECTING_PEERS.min(system_limit.max(1))
}

fn paused_runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the runtime starts")
}

fn connect_until_refused(port: u16, peers: usize) -> usize {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut connected = Vec::with_capacity(peers);
    for _ in 0..peers {
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

    let peers = reconnecting_peers();
    let connected = connect_until_refused(transport.port(), peers);

    assert_eq!(
        connected, peers,
        "the system held only {connected} of {peers} peer connections for a transport that had not accepted them yet"
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

    let peers = reconnecting_peers();
    let connected = connect_until_refused(transport.port(), peers);

    assert_eq!(
        connected, peers,
        "the system held only {connected} of {peers} peer connections for a transport that had not accepted them yet"
    );
    runtime.block_on(transport.shutdown());
}
