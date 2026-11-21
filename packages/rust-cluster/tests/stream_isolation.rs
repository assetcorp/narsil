use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use narsil_cluster::error::{ClusterError, codes};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{ChunkHandler, NodeTransport, Respond, listen_handler};
use tokio::sync::Notify;

const HELD_TYPE: &str = "test.held";
const STREAM_TYPE: &str = "test.stream";
const STREAM_CHUNKS: u8 = 3;
const REJECTED_CODE: &str = "CHUNK_REJECTED";

struct Gates {
    arrived: Arc<Notify>,
    release: Arc<Notify>,
}

fn tcp_pair() -> (TcpTransport, TcpTransport) {
    let config = || TcpTransportConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        ..TcpTransportConfig::default()
    };
    (
        TcpTransport::new("serving-node", config()).expect("the server configuration is valid"),
        TcpTransport::new("calling-node", config()).expect("the client configuration is valid"),
    )
}

fn grpc_pair() -> (GrpcTransport, GrpcTransport) {
    let config = || GrpcTransportConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        ..GrpcTransportConfig::default()
    };
    (
        GrpcTransport::new("serving-node", config()).expect("the server configuration is valid"),
        GrpcTransport::new("calling-node", config()).expect("the client configuration is valid"),
    )
}

async fn serve(server: &dyn NodeTransport) -> Gates {
    let gates = Gates {
        arrived: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    };
    let arrived = Arc::clone(&gates.arrived);
    let release = Arc::clone(&gates.release);
    let handler = listen_handler(move |message: TransportMessage, respond: Respond| {
        let arrived = Arc::clone(&arrived);
        let release = Arc::clone(&release);
        async move {
            if message.message_type == HELD_TYPE {
                arrived.notify_one();
                release.notified().await;
                let answer = TransportMessage::new(
                    "test.answer",
                    "serving-node",
                    message.request_id,
                    Bytes::new(),
                );
                respond.send(answer).await;
                return Ok(());
            }
            for chunk in 1..=STREAM_CHUNKS {
                let payload = Bytes::from(vec![chunk]);
                let answer = TransportMessage::new(
                    "test.chunk",
                    "serving-node",
                    message.request_id.clone(),
                    payload,
                );
                respond.send(answer).await;
            }
            Ok(())
        }
    });
    server.listen(handler).await.expect("the server listens");
    gates
}

fn request(message_type: &str, request_id: &str) -> TransportMessage {
    TransportMessage::new(message_type, "calling-node", request_id, Bytes::new())
}

fn failing_on_second_chunk(received: Arc<AtomicUsize>, panics: bool) -> ChunkHandler {
    Box::new(move |chunk: Bytes| {
        let count = received.fetch_add(1, Ordering::AcqRel) + 1;
        assert_eq!(chunk.as_ref(), [count as u8]);
        if count == 2 {
            assert!(!panics, "the chunk handler gave up");
            return Err(ClusterError::new(
                REJECTED_CODE,
                "The second chunk is rejected",
            ));
        }
        Ok(())
    })
}

async fn a_failing_chunk_handler_ends_only_its_own_stream(
    server: &dyn NodeTransport,
    client: &dyn NodeTransport,
    target: &str,
    gates: Gates,
) {
    for (panics, expected_code) in [(false, REJECTED_CODE), (true, codes::INTERNAL_ERROR)] {
        let held_id = format!("held-{panics}");
        let received = Arc::new(AtomicUsize::new(0));
        let held = client.send(target, request(HELD_TYPE, &held_id));
        let streamed = async {
            gates.arrived.notified().await;
            let handler = failing_on_second_chunk(Arc::clone(&received), panics);
            let outcome = client
                .stream(
                    target,
                    request(STREAM_TYPE, &format!("stream-{panics}")),
                    handler,
                )
                .await;
            gates.release.notify_one();
            outcome
        };
        let (held, streamed) = tokio::join!(held, streamed);

        let failure = streamed.expect_err("the stream fails once its handler fails");
        assert_eq!(failure.code(), expected_code);
        assert_eq!(received.load(Ordering::Acquire), 2);
        assert_eq!(
            held.expect("the connection answers the held request")
                .request_id,
            held_id
        );
    }

    let complete = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&complete);
    let counting: ChunkHandler = Box::new(move |_| {
        counted.fetch_add(1, Ordering::AcqRel);
        Ok(())
    });
    client
        .stream(target, request(STREAM_TYPE, "stream-after"), counting)
        .await
        .expect("a later stream to the same node completes");
    assert_eq!(complete.load(Ordering::Acquire), usize::from(STREAM_CHUNKS));
    server.shutdown().await;
    client.shutdown().await;
}

#[tokio::test]
async fn a_failing_chunk_handler_ends_only_its_own_tcp_stream() {
    let (server, client) = tcp_pair();
    let gates = serve(&server).await;
    let target = format!("127.0.0.1:{}", server.port());
    a_failing_chunk_handler_ends_only_its_own_stream(&server, &client, &target, gates).await;
}

#[tokio::test]
async fn a_failing_chunk_handler_ends_only_its_own_grpc_stream() {
    let (server, client) = grpc_pair();
    let gates = serve(&server).await;
    let target = format!("127.0.0.1:{}", server.port());
    a_failing_chunk_handler_ends_only_its_own_stream(&server, &client, &target, gates).await;
}

#[tokio::test]
async fn a_tcp_request_id_that_already_waits_is_refused_and_the_first_caller_gets_its_own_answer() {
    let (server, client) = tcp_pair();
    let gates = serve(&server).await;
    let target = format!("127.0.0.1:{}", server.port());

    let first = client.send(&target, request(HELD_TYPE, "shared-id"));
    let second = async {
        gates.arrived.notified().await;
        let outcome = client.send(&target, request(HELD_TYPE, "shared-id")).await;
        gates.release.notify_one();
        outcome
    };
    let (first, second) = tokio::join!(first, second);

    let refusal = second.expect_err("a second request under a waiting id is refused");
    assert_eq!(refusal.code(), codes::TRANSPORT_CONNECT_FAILED);
    let answer = first.expect("the first request gets its answer");
    assert_eq!(answer.request_id, "shared-id");
    assert_eq!(answer.message_type, "test.answer");

    let reused = client.send(&target, request(HELD_TYPE, "shared-id"));
    let released = async {
        gates.arrived.notified().await;
        gates.release.notify_one();
    };
    let (reused, ()) = tokio::join!(reused, released);
    assert_eq!(
        reused
            .expect("an id that no longer waits can be used again")
            .request_id,
        "shared-id"
    );
    server.shutdown().await;
    client.shutdown().await;
}
