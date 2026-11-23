use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use narsil::{Map, Value};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::{AllocationTable, NodeCapacity, NodeRegistration};
use narsil_cluster::error::{ClusterResult, codes};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig, next_started_at};
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{
    ListenHandler, NodeTransport, Respond, TlsConfig, TransportConfig, listen_handler,
};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::data_node::{cluster_coordinator, create_cluster_index};
use crate::spread::titled;

const LOOPBACK: &str = "127.0.0.1";
const WAITERS_PER_METHOD: usize = 5;
const SHORT_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const LONG_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const ONE_SHARED_TIMEOUT_WITHIN: Duration = Duration::from_secs(4);
const SHUTDOWN_WITHIN: Duration = Duration::from_secs(3);
const SETTLES_WITHIN: Duration = Duration::from_secs(5);
const DELIVERED_WITHIN: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy)]
enum Carrier {
    Tcp,
    Grpc,
}

const CARRIERS: [Carrier; 2] = [Carrier::Tcp, Carrier::Grpc];

struct Transport {
    node: Arc<dyn NodeTransport>,
    port: Box<dyn Fn() -> u16>,
}

fn transport(carrier: Carrier, connect_timeout: Duration, tls: Option<&TlsConfig>) -> Transport {
    let host = LOOPBACK.to_string();
    let timeouts = TransportConfig {
        connect_timeout,
        ..TransportConfig::default()
    };
    let tls = tls.cloned();
    match carrier {
        Carrier::Tcp => {
            let config = TcpTransportConfig {
                host,
                port: 0,
                timeouts,
                tls,
                ..TcpTransportConfig::default()
            };
            let node = Arc::new(TcpTransport::new("test-node", config).expect("a valid TCP node"));
            let bound = Arc::clone(&node);
            Transport {
                node,
                port: Box::new(move || bound.port()),
            }
        }
        Carrier::Grpc => {
            let config = GrpcTransportConfig {
                host,
                port: 0,
                timeouts,
                tls,
                ..GrpcTransportConfig::default()
            };
            let node =
                Arc::new(GrpcTransport::new("test-node", config).expect("a valid gRPC node"));
            let bound = Arc::clone(&node);
            Transport {
                node,
                port: Box::new(move || bound.port()),
            }
        }
    }
}

fn mutual_tls() -> TlsConfig {
    let mut authority = CertificateParams::new(Vec::<String>::new()).expect("authority parameters");
    authority.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let authority_key = KeyPair::generate().expect("an authority key");
    let authority_certificate = authority
        .self_signed(&authority_key)
        .expect("an authority certificate");
    let issuer = Issuer::new(authority, authority_key);
    let node_key = KeyPair::generate().expect("a node key");
    let node_certificate = CertificateParams::new(vec![LOOPBACK.to_string()])
        .expect("node parameters")
        .signed_by(&node_key, &issuer)
        .expect("a node certificate");
    TlsConfig {
        cert: node_certificate.pem().into_bytes(),
        key: node_key.serialize_pem().into_bytes(),
        ca: authority_certificate.pem().into_bytes(),
    }
}

#[derive(Default)]
struct Seen {
    accepted: AtomicUsize,
    began: AtomicUsize,
    ended: AtomicUsize,
}

async fn hold_silent(mut socket: TcpStream, seen: Arc<Seen>) {
    let mut buffer = [0u8; 4096];
    let mut has_begun = false;
    while let Ok(1..) = socket.read(&mut buffer).await {
        if !has_begun {
            has_begun = true;
            seen.began.fetch_add(1, Ordering::AcqRel);
        }
    }
    seen.ended.fetch_add(1, Ordering::AcqRel);
}

async fn receiving_side(relay_after_first: Option<u16>) -> (String, Arc<Seen>) {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.expect("a free port");
    let port = listener.local_addr().expect("a bound address").port();
    let seen = Arc::new(Seen::default());
    let counted = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let position = counted.accepted.fetch_add(1, Ordering::AcqRel);
            match relay_after_first {
                Some(port) if position > 0 => {
                    tokio::spawn(async move {
                        if let Ok(mut outbound) = TcpStream::connect((LOOPBACK, port)).await {
                            let _ =
                                tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                        }
                    });
                }
                _ => {
                    tokio::spawn(hold_silent(inbound, Arc::clone(&counted)));
                }
            }
        }
    });
    (format!("{LOOPBACK}:{port}"), seen)
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let started = Instant::now();
    while !check() {
        assert!(started.elapsed() < SETTLES_WITHIN, "never saw {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn request(request_id: String) -> TransportMessage {
    TransportMessage::new(
        "test.request",
        "calling-node",
        request_id,
        Bytes::from_static(b"payload"),
    )
}

fn waiting_calls(
    node: &Arc<dyn NodeTransport>,
    target: &str,
    per_method: usize,
) -> Vec<JoinHandle<ClusterResult<()>>> {
    (0..per_method)
        .flat_map(|at| {
            let (sender, streamer) = (Arc::clone(node), Arc::clone(node));
            let (send_to, stream_to) = (target.to_string(), target.to_string());
            [
                tokio::spawn(async move {
                    sender
                        .send(&send_to, request(format!("send-{at}")))
                        .await
                        .map(|_| ())
                }),
                tokio::spawn(async move {
                    streamer
                        .stream(
                            &stream_to,
                            request(format!("stream-{at}")),
                            Box::new(|_| Ok(())),
                        )
                        .await
                }),
            ]
        })
        .collect()
}

async fn failure_codes(calls: Vec<JoinHandle<ClusterResult<()>>>) -> Vec<String> {
    let mut failures = Vec::new();
    for call in calls {
        let outcome = tokio::time::timeout(SETTLES_WITHIN, call)
            .await
            .expect("the call settles")
            .expect("the call does not panic");
        failures.push(outcome.expect_err("the call fails").code().to_string());
    }
    failures
}

fn echo_handler() -> ListenHandler {
    listen_handler(|message: TransportMessage, respond: Respond| async move {
        respond.send(message).await;
        Ok(())
    })
}

#[tokio::test]
async fn waiters_share_one_failed_connect_and_the_next_call_connects_afresh() {
    let tls = mutual_tls();
    for carrier in CARRIERS {
        let receiver = transport(carrier, LONG_CONNECT_TIMEOUT, Some(&tls));
        receiver
            .node
            .listen(echo_handler())
            .await
            .expect("the receiver listens");
        let (target, seen) = receiving_side(Some((receiver.port)())).await;
        let sender = transport(carrier, SHORT_CONNECT_TIMEOUT, Some(&tls));

        let started = Instant::now();
        let failures =
            failure_codes(waiting_calls(&sender.node, &target, WAITERS_PER_METHOD)).await;

        assert!(started.elapsed() < ONE_SHARED_TIMEOUT_WITHIN, "{carrier:?}");
        assert_eq!(
            failures,
            [codes::TRANSPORT_CONNECT_FAILED; 10],
            "{carrier:?}"
        );
        assert_eq!(seen.accepted.load(Ordering::Acquire), 1, "{carrier:?}");
        eventually("the failed connect's socket close", || {
            seen.ended.load(Ordering::Acquire) == 1
        })
        .await;
        let answer = sender
            .node
            .send(&target, request("afresh".to_string()))
            .await
            .expect("the next call connects afresh");
        assert_eq!(answer.payload, Bytes::from_static(b"payload"));
        assert_eq!(seen.accepted.load(Ordering::Acquire), 2, "{carrier:?}");
        sender.node.shutdown().await;
        receiver.node.shutdown().await;
    }
}

#[tokio::test]
async fn shutdown_ends_a_connect_that_several_calls_wait_for() {
    let tls = mutual_tls();
    for carrier in CARRIERS {
        let (target, seen) = receiving_side(None).await;
        let sender = transport(carrier, LONG_CONNECT_TIMEOUT, Some(&tls));
        let waiting = waiting_calls(&sender.node, &target, WAITERS_PER_METHOD);
        eventually("the connect begin", || {
            seen.began.load(Ordering::Acquire) == 1
        })
        .await;

        let started = Instant::now();
        sender.node.shutdown().await;

        assert!(started.elapsed() < SHUTDOWN_WITHIN, "{carrier:?}");
        assert_eq!(
            failure_codes(waiting).await,
            [codes::TRANSPORT_CONNECT_FAILED; 10],
            "{carrier:?}"
        );
        eventually("the socket close", || {
            seen.ended.load(Ordering::Acquire) == 1
        })
        .await;
    }
}

#[tokio::test]
async fn shutdown_during_a_connect_to_a_healthy_peer_delivers_no_request() {
    for carrier in CARRIERS {
        let receiver = transport(carrier, LONG_CONNECT_TIMEOUT, None);
        let received = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&received);
        let counting = listen_handler(move |message: TransportMessage, respond: Respond| {
            counted.fetch_add(1, Ordering::AcqRel);
            async move {
                respond.send(message).await;
                Ok(())
            }
        });
        receiver
            .node
            .listen(counting)
            .await
            .expect("the receiver listens");
        let sender = transport(carrier, LONG_CONNECT_TIMEOUT, None);
        let target = format!("{LOOPBACK}:{}", (receiver.port)());

        let sent = sender.node.send(&target, request("sent".to_string()));
        let streamed = sender.node.stream(
            &target,
            request("streamed".to_string()),
            Box::new(|_| Ok(())),
        );
        let (sent, streamed, ()) = tokio::join!(sent, streamed, sender.node.shutdown());

        for failure in [sent.map(|_| ()), streamed] {
            let failure = failure.expect_err("shutdown stops the call");
            assert_eq!(
                failure.code(),
                codes::TRANSPORT_CONNECT_FAILED,
                "{carrier:?}"
            );
        }
        tokio::time::sleep(DELIVERED_WITHIN).await;
        assert_eq!(received.load(Ordering::Acquire), 0, "{carrier:?}");
        receiver.node.shutdown().await;
    }
}

#[tokio::test]
async fn shutdown_after_the_hand_over_reports_an_unknown_outcome() {
    for carrier in CARRIERS {
        let receiver = transport(carrier, LONG_CONNECT_TIMEOUT, None);
        let received = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&received);
        let holding = listen_handler(move |_message: TransportMessage, _respond: Respond| {
            counted.fetch_add(1, Ordering::AcqRel);
            std::future::pending()
        });
        receiver
            .node
            .listen(holding)
            .await
            .expect("the receiver listens");
        let sender = transport(carrier, LONG_CONNECT_TIMEOUT, None);
        let target = format!("{LOOPBACK}:{}", (receiver.port)());
        let handed_over = waiting_calls(&sender.node, &target, 1);
        eventually("both requests arrive", || {
            received.load(Ordering::Acquire) == 2
        })
        .await;

        let started = Instant::now();
        sender.node.shutdown().await;

        assert!(started.elapsed() < SHUTDOWN_WITHIN, "{carrier:?}");
        assert_eq!(
            failure_codes(handed_over).await,
            [codes::TRANSPORT_PEER_UNAVAILABLE; 2],
            "{carrier:?}"
        );
        receiver.node.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_write_never_reaches_the_fallback_after_a_slow_tls_connect_fails() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let tls = mutual_tls();
    let receiver = transport(Carrier::Tcp, LONG_CONNECT_TIMEOUT, Some(&tls));
    let received = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&received);
    receiver
        .node
        .listen(listen_handler(
            move |message: TransportMessage, respond: Respond| {
                counted.fetch_add(1, Ordering::AcqRel);
                async move {
                    respond.send(message).await;
                    Ok(())
                }
            },
        ))
        .await
        .expect("the fallback listens");
    let primary = format!("{LOOPBACK}:{}", (receiver.port)());
    let (silent, seen) = receiving_side(None).await;
    let registration = |node_id: String, address: String, role: &str| NodeRegistration {
        node_id,
        address,
        roles: vec![role.to_string()],
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: SPEC_VERSION.to_string(),
        extra: Map::new(),
    };
    coordinator
        .register_node(&registration(primary.clone(), silent, "data"))
        .await
        .expect("the primary advertises the silent TLS endpoint");
    let index = "expired-fallback";
    let uuid = "expired-fallback-uuid";
    create_cluster_index(&coordinator, index, uuid, 1, 0).await;
    let mut assignment = Map::new();
    assignment.insert("primary", Value::from(primary));
    assignment.insert("replicas", Value::Array(Vec::new()));
    assignment.insert("inSyncSet", Value::Array(Vec::new()));
    assignment.insert("commitPoint", Value::from(0.0));
    assignment.insert("state", Value::from("ACTIVE"));
    assignment.insert("primaryTerm", Value::from(1.0));
    coordinator
        .put_allocation(
            index,
            &AllocationTable {
                index_name: index.to_string(),
                version: 1.0,
                replication_factor: 0.0,
                assignments: vec![(0.0, assignment)],
                generation: None,
                index_uuid: Some(uuid.to_string()),
            },
        )
        .await
        .expect("the primary owns the partition");
    let sender = transport(Carrier::Tcp, Duration::from_secs(31), Some(&tls));
    sender
        .node
        .listen(echo_handler())
        .await
        .expect("the router binds")
        .stop();
    let node = ClusterNode::new(ClusterNodeConfig::new(
        Arc::clone(&coordinator),
        Arc::clone(&sender.node),
        registration(
            "expired-router".to_string(),
            format!("{LOOPBACK}:{}", (sender.port)()),
            "coordinator",
        ),
    ))
    .expect("valid router settings");
    node.start().await.expect("the router joins");
    let documents = ["batch-first", "batch-second"].map(|id| {
        let mut document = titled("expired transfer");
        document.insert("id", Value::from(id));
        document
    });
    let (single, batch) = tokio::join!(
        node.insert(index, titled("expired transfer"), Some("single")),
        node.insert_batch(index, documents.to_vec()),
    );
    let batch = batch.expect("the batch answers");
    assert!(batch.succeeded.is_empty());
    assert_eq!(batch.failed.len(), 2);
    let mut failures = vec![single.expect_err("the single write expires")];
    failures.extend(batch.failed.into_iter().map(|failure| failure.error));
    for error in failures {
        assert_eq!(error.code(), "REPLICATION_OUTCOME_UNKNOWN");
        assert_eq!(
            error.details().get("reason").and_then(Value::as_str),
            Some("forward_window_ended")
        );
    }
    eventually("the expired connection to close", || {
        seen.ended.load(Ordering::Acquire) > 0
    })
    .await;
    tokio::time::sleep(DELIVERED_WITHIN).await;
    let late = received.load(Ordering::Acquire);
    node.shutdown().await;
    sender.node.shutdown().await;
    receiver.node.shutdown().await;
    coordinator.shutdown().await;
    assert_eq!(
        late, 0,
        "a fallback receives writes after the client deadline"
    );
}
