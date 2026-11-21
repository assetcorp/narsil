mod support;

use std::time::{Duration, Instant};

use narsil_cluster::node::not_ready_handler;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use support::{
    FRAME_REQUEST, FRAME_RESPONSE, FRAME_STREAM_CHUNK, FRAME_STREAM_END, MAX_MESSAGE_SIZE_BYTES,
    NODE_ID, closes, decode, frame, ping_frame, ping_over, read_frame,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const CONNECTION_LIMIT: usize = 2;
const SLOT_RELEASE_WAIT: Duration = Duration::from_secs(5);

async fn listening_node(max_connections: usize) -> (TcpTransport, String) {
    let transport = TcpTransport::new(
        NODE_ID,
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            max_connections,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the transport accepts a plain configuration");
    transport
        .listen(not_ready_handler(NODE_ID))
        .await
        .expect("the transport listens");
    let address = format!("127.0.0.1:{}", transport.port());
    (transport, address)
}

async fn connect(address: &str) -> TcpStream {
    TcpStream::connect(address)
        .await
        .expect("the node accepts a TCP connection")
}

#[tokio::test]
async fn a_frame_that_cannot_be_read_closes_only_its_own_connection() {
    let (transport, address) = listening_node(CONNECTION_LIMIT).await;
    let too_long = ((MAX_MESSAGE_SIZE_BYTES + 1) as u32).to_be_bytes().to_vec();
    let mut not_a_map = 5u32.to_be_bytes().to_vec();
    not_a_map.extend_from_slice(&[0xc1; 5]);
    let mut truncated = 64u32.to_be_bytes().to_vec();
    truncated.extend_from_slice(&[0x83; 3]);

    for opening in [u32::MAX.to_be_bytes().to_vec(), too_long, not_a_map] {
        let mut hostile = connect(&address).await;
        hostile
            .write_all(&opening)
            .await
            .expect("the node takes the bytes");
        assert!(
            closes(&mut hostile).await,
            "the node kept a connection open after {opening:02x?}"
        );
        ping_over(&mut connect(&address).await, "after-hostile-frame").await;
    }

    let mut hostile = connect(&address).await;
    hostile
        .write_all(&truncated)
        .await
        .expect("the node takes the bytes");
    hostile.shutdown().await.expect("the half close goes out");
    assert!(
        closes(&mut hostile).await,
        "the node kept a half-closed connection open"
    );
    ping_over(&mut connect(&address).await, "after-truncated-frame").await;
    transport.shutdown().await;
}

#[tokio::test]
async fn an_envelope_that_cannot_be_decoded_gets_a_carrier_error_and_the_connection_keeps_serving()
{
    let (transport, address) = listening_node(CONNECTION_LIMIT).await;
    let mut peer = connect(&address).await;

    for (request_id, data) in [
        ("not-msgpack", vec![0xc1]),
        (
            "no-payload",
            vec![0x81, 0xa4, b't', b'y', b'p', b'e', 0xa1, b'x'],
        ),
    ] {
        peer.write_all(&frame(FRAME_REQUEST, request_id, &data))
            .await
            .expect("the node takes the frame");
        let reply = read_frame(&mut peer)
            .await
            .expect("the node answers the frame");
        assert_eq!(reply.unsigned("frameType"), FRAME_RESPONSE);
        assert_eq!(reply.text("requestId"), request_id);
        let carrier = decode(&reply.bytes("data"));
        assert_eq!(carrier.keys(), ["type", "sourceId", "requestId", "payload"]);
        assert_eq!(carrier.text("type"), "error");
        assert_eq!(carrier.text("sourceId"), "");
        assert_eq!(carrier.text("requestId"), request_id);
        let text =
            String::from_utf8(carrier.bytes("payload")).expect("a carrier error holds UTF-8 text");
        assert!(text.contains("cannot be decoded"), "{text}");
    }

    ping_over(&mut peer, "after-undecodable").await;
    transport.shutdown().await;
}

#[tokio::test]
async fn frames_that_are_not_requests_go_unanswered() {
    let (transport, address) = listening_node(CONNECTION_LIMIT).await;
    let mut peer = connect(&address).await;
    for frame_type in [
        FRAME_RESPONSE,
        FRAME_STREAM_CHUNK,
        FRAME_STREAM_END,
        0,
        9,
        9_007_199_254_740_991,
    ] {
        peer.write_all(&frame(frame_type, "unsolicited", &[1, 2, 3]))
            .await
            .expect("the node takes the frame");
    }

    ping_over(&mut peer, "after-unsolicited").await;
    transport.shutdown().await;
}

#[tokio::test]
async fn a_listener_that_panics_before_returning_its_future_sends_a_carrier_error() {
    let (transport, address) = listening_node(CONNECTION_LIMIT).await;
    let handler = std::sync::Arc::new(|_, _| panic!("listener failed"));
    let listening = transport
        .listen(handler)
        .await
        .expect("the handler changes");
    let mut peer = connect(&address).await;
    peer.write_all(&ping_frame("panic"))
        .await
        .expect("the request leaves");

    let reply = read_frame(&mut peer)
        .await
        .expect("the node reports the failure");
    let carrier = decode(&reply.bytes("data"));
    assert_eq!(carrier.text("type"), "error");
    assert_eq!(carrier.text("requestId"), "panic");
    assert_eq!(carrier.text("sourceId"), "");
    listening.stop();
    ping_over(&mut peer, "after-panic").await;
    transport.shutdown().await;
}

#[tokio::test]
async fn the_listener_drops_a_connection_past_its_limit_and_accepts_again_once_one_closes() {
    let (transport, address) = listening_node(CONNECTION_LIMIT).await;
    let mut held = Vec::new();
    for at in 0..CONNECTION_LIMIT {
        let mut peer = connect(&address).await;
        ping_over(&mut peer, &format!("held-{at}")).await;
        held.push(peer);
    }

    let mut refused = connect(&address).await;
    let _ = refused.write_all(&ping_frame("past-limit")).await;
    assert!(
        closes(&mut refused).await,
        "the node served a connection past its limit"
    );

    drop(held.pop());
    let started = Instant::now();
    loop {
        let mut peer = connect(&address).await;
        if peer.write_all(&ping_frame("after-release")).await.is_ok()
            && let Some(reply) = read_frame(&mut peer).await
        {
            assert_eq!(reply.text("requestId"), "after-release");
            break;
        }
        assert!(
            started.elapsed() < SLOT_RELEASE_WAIT,
            "the node never freed the closed connection's slot"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    transport.shutdown().await;
}
