mod support;

use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::{TokioExecutor, TokioIo};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::node::not_ready_handler;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::{
    ListenHandler, NodeTransport, Respond, TransportConfig, listen_handler,
};
use support::{NODE_ID, PING_TIMESTAMP, assert_pong, decode, envelope, ping_payload};
use tokio::net::TcpStream;

const SEND_PATH: &str = "/narsil.transport.v1.NodeTransport/Send";
const OPEN_STREAM_PATH: &str = "/narsil.transport.v1.NodeTransport/OpenStream";
const GRPC_OK: &str = "0";
const GRPC_INVALID_ARGUMENT: &str = "3";
const GRPC_DEADLINE_EXCEEDED: &str = "4";
const GRPC_RESOURCE_EXHAUSTED: &str = "8";
const GRPC_UNIMPLEMENTED: &str = "12";
const GRPC_ENVELOPE_OVERHEAD_BYTES: usize = 1_024;
const CLIENT_DEADLINE: Duration = Duration::from_millis(300);
const SERVER_REQUEST_TIMEOUT: Duration = Duration::from_millis(600);
const DEADLINE_SLACK: Duration = Duration::from_secs(2);
const CALL_WAIT: Duration = Duration::from_secs(20);

struct Answer {
    grpc_status: String,
    messages: Vec<Vec<u8>>,
}

async fn listening_node(handler: ListenHandler) -> (GrpcTransport, String) {
    let transport = GrpcTransport::new(
        NODE_ID,
        GrpcTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            timeouts: TransportConfig {
                request_timeout: SERVER_REQUEST_TIMEOUT,
                ..TransportConfig::default()
            },
            ..GrpcTransportConfig::default()
        },
    )
    .expect("the transport accepts a plain configuration");
    transport
        .listen(handler)
        .await
        .expect("the transport listens");
    let address = format!("127.0.0.1:{}", transport.port());
    (transport, address)
}

fn silent_handler() -> ListenHandler {
    listen_handler(|_message: TransportMessage, _respond: Respond| async { Ok(()) })
}

fn write_varint(out: &mut Vec<u8>, mut value: usize) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn grpc_frame(field_bytes: &[u8]) -> Vec<u8> {
    let mut message = vec![0x0a];
    write_varint(&mut message, field_bytes.len());
    message.extend_from_slice(field_bytes);
    let mut out = vec![0];
    out.extend_from_slice(&(message.len() as u32).to_be_bytes());
    out.extend_from_slice(&message);
    out
}

fn read_varint(bytes: &[u8], at: &mut usize) -> usize {
    let mut value = 0;
    let mut shift = 0;
    loop {
        let byte = bytes[*at];
        *at += 1;
        value |= usize::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn first_field_of_each_frame(body: &[u8]) -> Vec<Vec<u8>> {
    let mut messages = Vec::new();
    let mut at = 0;
    while at < body.len() {
        assert_eq!(body[at], 0, "the node compressed a message");
        let length =
            u32::from_be_bytes([body[at + 1], body[at + 2], body[at + 3], body[at + 4]]) as usize;
        let message = &body[at + 5..at + 5 + length];
        at += 5 + length;
        if message.is_empty() {
            messages.push(Vec::new());
            continue;
        }
        assert_eq!(
            message[0], 0x0a,
            "the message does not open with field 1 as bytes"
        );
        let mut offset = 1;
        let field_length = read_varint(message, &mut offset);
        messages.push(message[offset..offset + field_length].to_vec());
    }
    messages
}

async fn call(address: &str, path: &str, body: Vec<u8>, deadline: Option<&str>) -> Answer {
    let socket = TcpStream::connect(address)
        .await
        .expect("the node accepts a TCP connection");
    let (mut sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(socket))
            .await
            .expect("the node speaks HTTP/2");
    tokio::spawn(connection);
    let mut request = http::Request::builder()
        .method("POST")
        .uri(format!("http://{address}{path}"))
        .header("content-type", "application/grpc")
        .header("te", "trailers");
    if let Some(deadline) = deadline {
        request = request.header("grpc-timeout", deadline);
    }
    let request = request
        .body(Full::new(Bytes::from(body)))
        .expect("the request is well formed");
    let exchange = async {
        let response = sender
            .send_request(request)
            .await
            .expect("the node answers the call");
        let header_status = response
            .headers()
            .get("grpc-status")
            .map(|value| value.to_str().unwrap_or("").to_string());
        let collected = response
            .into_body()
            .collect()
            .await
            .expect("the node finishes the body");
        let trailer_status = collected
            .trailers()
            .and_then(|trailers| trailers.get("grpc-status"))
            .map(|value| value.to_str().unwrap_or("").to_string());
        Answer {
            grpc_status: trailer_status
                .or(header_status)
                .expect("the node sends a grpc-status"),
            messages: first_field_of_each_frame(&collected.to_bytes()),
        }
    };
    tokio::time::timeout(CALL_WAIT, exchange)
        .await
        .expect("the node finished the call in time")
}

#[tokio::test]
async fn send_answers_a_ping_in_the_envelope_that_a_typescript_node_reads() {
    let (transport, address) = listening_node(not_ready_handler(NODE_ID)).await;
    let ping = envelope("cluster.ping", "grpc-ping", &ping_payload(PING_TIMESTAMP));

    let answer = call(&address, SEND_PATH, grpc_frame(&ping), None).await;

    assert_eq!(answer.grpc_status, GRPC_OK);
    assert_eq!(answer.messages.len(), 1);
    assert_pong(&decode(&answer.messages[0]), "grpc-ping");
    transport.shutdown().await;
}

#[tokio::test]
async fn send_answers_an_envelope_that_cannot_be_decoded_with_a_carrier_error() {
    let (transport, address) = listening_node(not_ready_handler(NODE_ID)).await;

    for undecodable in [
        vec![0xc1],
        Vec::new(),
        envelope("cluster.ping", "trailing", &[])[..20].to_vec(),
    ] {
        let answer = call(&address, SEND_PATH, grpc_frame(&undecodable), None).await;

        assert_eq!(answer.grpc_status, GRPC_OK);
        let carrier = decode(&answer.messages[0]);
        assert_eq!(carrier.keys(), ["type", "sourceId", "requestId", "payload"]);
        assert_eq!(carrier.text("type"), "error");
        assert_eq!(carrier.text("sourceId"), "");
        assert_eq!(carrier.text("requestId"), "");
        let text =
            String::from_utf8(carrier.bytes("payload")).expect("a carrier error holds UTF-8 text");
        assert!(text.contains("cannot be decoded"), "{text}");
    }
    transport.shutdown().await;
}

#[tokio::test]
async fn send_holds_a_call_that_gets_no_answer_until_the_callers_deadline_and_no_longer() {
    let (transport, address) = listening_node(silent_handler()).await;
    let request = grpc_frame(&envelope("test.silent", "silent", &[]));

    for (deadline, expected) in [
        (Some("300m"), CLIENT_DEADLINE),
        (None, SERVER_REQUEST_TIMEOUT),
        (Some("5x"), SERVER_REQUEST_TIMEOUT),
    ] {
        let started = Instant::now();
        let answer = call(&address, SEND_PATH, request.clone(), deadline).await;
        let waited = started.elapsed();

        assert_eq!(answer.grpc_status, GRPC_DEADLINE_EXCEEDED, "{deadline:?}");
        assert!(waited >= expected, "{deadline:?} ended after {waited:?}");
        assert!(
            waited < expected + DEADLINE_SLACK,
            "{deadline:?} ended after {waited:?}"
        );
    }
    transport.shutdown().await;
}

#[tokio::test]
async fn a_listener_that_panics_before_returning_its_future_sends_a_carrier_error() {
    let handler: ListenHandler = std::sync::Arc::new(|_, _| panic!("listener failed"));
    let (transport, address) = listening_node(handler).await;
    let request = grpc_frame(&envelope("test.panic", "panic", &[]));

    let answer = call(&address, SEND_PATH, request, None).await;

    assert_eq!(answer.grpc_status, GRPC_OK);
    let carrier = decode(&answer.messages[0]);
    assert_eq!(carrier.text("type"), "error");
    assert_eq!(carrier.text("requestId"), "panic");
    assert_eq!(carrier.text("sourceId"), "");
    transport.shutdown().await;
}

#[tokio::test]
async fn a_message_past_the_size_limit_is_refused_as_resource_exhausted() {
    let (transport, address) = listening_node(not_ready_handler(NODE_ID)).await;
    let oversized = vec![0u8; support::MAX_MESSAGE_SIZE_BYTES + GRPC_ENVELOPE_OVERHEAD_BYTES];

    let answer = call(&address, SEND_PATH, grpc_frame(&oversized), None).await;

    assert_eq!(answer.grpc_status, GRPC_RESOURCE_EXHAUSTED);
    let ping = envelope(
        "cluster.ping",
        "after-oversized",
        &ping_payload(PING_TIMESTAMP),
    );
    let after = call(&address, SEND_PATH, grpc_frame(&ping), None).await;
    assert_pong(&decode(&after.messages[0]), "after-oversized");
    transport.shutdown().await;
}

#[tokio::test]
async fn open_stream_refuses_an_envelope_that_cannot_be_decoded_and_an_unknown_method_is_unimplemented()
 {
    let (transport, address) = listening_node(not_ready_handler(NODE_ID)).await;

    let refused = call(&address, OPEN_STREAM_PATH, grpc_frame(&[0xc1]), None).await;
    assert_eq!(refused.grpc_status, GRPC_INVALID_ARGUMENT);
    assert!(refused.messages.is_empty());

    let unknown = call(
        &address,
        "/narsil.transport.v1.NodeTransport/Drop",
        grpc_frame(&[]),
        None,
    )
    .await;
    assert_eq!(unknown.grpc_status, GRPC_UNIMPLEMENTED);
    transport.shutdown().await;
}
