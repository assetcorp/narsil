use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use narsil_cluster::error::codes;
use narsil_cluster::message::{CARRIER_ERROR_TYPE, TransportMessage};
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{ChunkHandler, NodeTransport};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const PEER_START_WAIT: Duration = Duration::from_secs(30);
const LARGE_PAYLOAD_BYTES: usize = 3 * 1024 * 1024 + 17;

struct TypescriptPeer {
    child: Child,
    tcp: String,
    grpc: String,
}

async fn start_peer() -> TypescriptPeer {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repository_root = manifest.join("../..");
    let mut child = Command::new("node")
        .arg(manifest.join("tests/support/typescript_peer.mjs"))
        .arg(&repository_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node starts the TypeScript peer");
    let stdout = child.stdout.take().expect("the peer's stdout is piped");
    let mut lines = BufReader::new(stdout).lines();
    let announced = tokio::time::timeout(PEER_START_WAIT, lines.next_line())
        .await
        .expect("the TypeScript peer announced its ports in time")
        .expect("the peer's stdout is readable")
        .expect("the peer printed a line before it exited; build packages/ts first");
    let ports: Vec<&str> = announced
        .trim()
        .strip_prefix("PORTS ")
        .expect("the peer announces its ports")
        .split(' ')
        .collect();
    TypescriptPeer {
        tcp: format!("127.0.0.1:{}", ports[0]),
        grpc: format!("127.0.0.1:{}", ports[1]),
        child,
    }
}

fn every_byte_value() -> Bytes {
    Bytes::from(
        (0..=255u8)
            .cycle()
            .take(LARGE_PAYLOAD_BYTES)
            .collect::<Vec<u8>>(),
    )
}

async fn reaches_a_typescript_listener(client: &dyn NodeTransport, target: &str) {
    for (message_type, request_id, payload) in [
        ("test.echo", "ascii-request", Bytes::new()),
        (
            "test.echo",
            "requête-ünïcode-✓",
            Bytes::from_static(&[0xc1, 0x00, 0xff]),
        ),
        ("test.echo", "large-request", every_byte_value()),
    ] {
        let request =
            TransportMessage::new(message_type, "rust-caller", request_id, payload.clone());
        let answer = client
            .send(target, request)
            .await
            .expect("the TypeScript listener answers");

        assert_eq!(answer.message_type, "test.echo");
        assert_eq!(answer.source_id, "rust-caller");
        assert_eq!(answer.request_id, request_id);
        assert_eq!(answer.payload, payload);
    }

    let refused = client
        .send(
            target,
            TransportMessage::new("test.fail", "rust-caller", "refused", Bytes::new()),
        )
        .await
        .expect("a listener failure arrives as an answer");
    assert_eq!(refused.message_type, CARRIER_ERROR_TYPE);
    assert_eq!(refused.request_id, "refused");
    assert!(String::from_utf8_lossy(&refused.payload).contains("refused the request"));

    let chunks = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&chunks);
    let collecting: ChunkHandler = Box::new(move |chunk: Bytes| {
        collected
            .lock()
            .expect("the chunk list is unpoisoned")
            .push(chunk.to_vec());
        Ok(())
    });
    client
        .stream(
            target,
            TransportMessage::new("test.stream", "rust-caller", "streamed", Bytes::new()),
            collecting,
        )
        .await
        .expect("the TypeScript listener streams its chunks");
    assert_eq!(
        *chunks.lock().expect("the chunk list is unpoisoned"),
        [vec![1], vec![2], vec![3]]
    );

    let ignoring: ChunkHandler = Box::new(|_| Ok(()));
    let failed = client
        .stream(
            target,
            TransportMessage::new("test.fail", "rust-caller", "failed-stream", Bytes::new()),
            ignoring,
        )
        .await
        .expect_err("a stream whose listener fails fails");
    assert_eq!(failed.code(), codes::TRANSPORT_PEER_UNAVAILABLE);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rust_transports_reach_a_typescript_listener_with_the_bytes_that_it_reads() {
    let mut peer = start_peer().await;
    let tcp = TcpTransport::new(
        "rust-caller",
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the TCP configuration is valid");
    let grpc = GrpcTransport::new(
        "rust-caller",
        GrpcTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..GrpcTransportConfig::default()
        },
    )
    .expect("the gRPC configuration is valid");

    reaches_a_typescript_listener(&tcp, &peer.tcp).await;
    reaches_a_typescript_listener(&grpc, &peer.grpc).await;

    tcp.shutdown().await;
    grpc.shutdown().await;
    drop(peer.child.stdin.take());
    let _ = tokio::time::timeout(PEER_START_WAIT, peer.child.wait()).await;
}
