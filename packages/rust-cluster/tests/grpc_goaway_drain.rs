use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Request, Response};
use http_body::Frame;
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use narsil_cluster::error::{ClusterResult, codes};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::grpc::{GrpcTransport, GrpcTransportConfig};
use narsil_cluster::transport::{NodeTransport, TransportConfig};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;

const LOOPBACK: &str = "127.0.0.1";
const OPEN_STREAM_PATH: &str = "/narsil.transport.v1.NodeTransport/OpenStream";
const CHUNKS: u8 = 26;
const CHUNKS_BEFORE_GOAWAY: u8 = 2;
const CHUNK_FIELD_KEY: u8 = 0x0a;
const GRPC_STATUS_OK: &str = "0";
const GRPC_STATUS_UNIMPLEMENTED: &str = "12";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const SETTLES_WITHIN: Duration = Duration::from_secs(10);
const SHUTDOWN_WITHIN: Duration = Duration::from_secs(3);
const RECONNECT_EVERY: Duration = Duration::from_millis(10);

struct Frames(mpsc::Receiver<Frame<Bytes>>);

impl http_body::Body for Frames {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0.poll_recv(context).map(|frame| frame.map(Ok))
    }
}

fn grpc_status(code: &'static str) -> HeaderMap {
    let mut trailers = HeaderMap::new();
    trailers.insert("grpc-status", HeaderValue::from_static(code));
    trailers
}

fn trailers_only(code: &'static str) -> Frames {
    let (frames, body) = mpsc::channel(1);
    let _ = frames.try_send(Frame::trailers(grpc_status(code)));
    Frames(body)
}

fn chunk_frame(value: u8) -> Frame<Bytes> {
    Frame::data(Bytes::from(vec![0, 0, 0, 0, 3, CHUNK_FIELD_KEY, 1, value]))
}

struct DrainingPeer {
    target: String,
    went_away: oneshot::Receiver<()>,
    resume: Arc<Notify>,
    disconnected: oneshot::Receiver<()>,
}

async fn draining_peer() -> DrainingPeer {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.expect("a free port");
    let port = listener.local_addr().expect("a bound address").port();
    let (went_away_signal, went_away) = oneshot::channel();
    let (disconnected_signal, disconnected) = oneshot::channel();
    let resume = Arc::new(Notify::new());
    let resumed = Arc::clone(&resume);
    let (frames, body) = mpsc::channel(usize::from(CHUNKS) + 1);
    let stream_body = Arc::new(Mutex::new(Some(Frames(body))));
    let stream_opened = Arc::new(Notify::new());
    let opened = Arc::clone(&stream_opened);
    tokio::spawn(async move {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        drop(listener);
        let service = hyper::service::service_fn(move |request: Request<Incoming>| {
            let streamed = (request.uri().path() == OPEN_STREAM_PATH)
                .then(|| {
                    stream_body
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take()
                })
                .flatten();
            if streamed.is_some() {
                opened.notify_one();
            }
            let body = streamed.unwrap_or_else(|| trailers_only(GRPC_STATUS_UNIMPLEMENTED));
            async move {
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(200)
                        .header("content-type", "application/grpc")
                        .body(body)
                        .expect("a valid response"),
                )
            }
        });
        let connection = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .serve_connection(TokioIo::new(socket), service);
        tokio::pin!(connection);
        tokio::select! {
            _ = connection.as_mut() => {
                let _ = disconnected_signal.send(());
                return;
            }
            _ = stream_opened.notified() => {}
        }
        for value in 0..CHUNKS_BEFORE_GOAWAY {
            let _ = frames.send(chunk_frame(value)).await;
        }
        connection.as_mut().graceful_shutdown();
        let _ = went_away_signal.send(());
        let feeding = async move {
            resumed.notified().await;
            for value in CHUNKS_BEFORE_GOAWAY..CHUNKS {
                if frames.send(chunk_frame(value)).await.is_err() {
                    return;
                }
            }
            let _ = frames
                .send(Frame::trailers(grpc_status(GRPC_STATUS_OK)))
                .await;
        };
        tokio::pin!(feeding);
        let mut fed = false;
        loop {
            tokio::select! {
                _ = connection.as_mut() => break,
                _ = &mut feeding, if !fed => fed = true,
            }
        }
        let _ = disconnected_signal.send(());
    });
    DrainingPeer {
        target: format!("{LOOPBACK}:{port}"),
        went_away,
        resume,
        disconnected,
    }
}

fn sender() -> Arc<GrpcTransport> {
    let config = GrpcTransportConfig {
        host: LOOPBACK.to_string(),
        port: 0,
        timeouts: TransportConfig {
            connect_timeout: CONNECT_TIMEOUT,
            ..TransportConfig::default()
        },
        ..GrpcTransportConfig::default()
    };
    Arc::new(GrpcTransport::new("sender", config).expect("a valid gRPC node"))
}

fn request(request_id: &str) -> TransportMessage {
    TransportMessage::new(
        "test.request",
        "sender",
        request_id.to_string(),
        Bytes::from_static(b"payload"),
    )
}

struct Draining {
    streaming: JoinHandle<ClusterResult<()>>,
    received: Arc<AtomicUsize>,
}

async fn stream_until_a_reconnect_fails(
    sender: &Arc<GrpcTransport>,
    peer: &mut DrainingPeer,
) -> Draining {
    let received = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&received);
    let streamer = Arc::clone(sender);
    let target = peer.target.clone();
    let streaming = tokio::spawn(async move {
        streamer
            .stream(
                &target,
                request("drained-stream"),
                Box::new(move |_| {
                    counted.fetch_add(1, Ordering::AcqRel);
                    Ok(())
                }),
            )
            .await
    });
    tokio::time::timeout(SETTLES_WITHIN, &mut peer.went_away)
        .await
        .expect("the peer sends GOAWAY in time")
        .expect("the peer reports its GOAWAY");
    let started = Instant::now();
    loop {
        let outcome = sender.send(&peer.target, request("after-goaway")).await;
        let code = outcome.err().map(|error| error.code().to_string());
        if code.as_deref() == Some(codes::TRANSPORT_CONNECT_FAILED) {
            break;
        }
        assert!(
            started.elapsed() < SETTLES_WITHIN,
            "the reconnect never failed, last outcome {code:?}"
        );
        tokio::time::sleep(RECONNECT_EVERY).await;
    }
    Draining {
        streaming,
        received,
    }
}

#[tokio::test]
async fn a_stream_finishes_after_goaway_while_the_reconnect_fails() {
    let mut peer = draining_peer().await;
    let sender = sender();
    let draining = stream_until_a_reconnect_fails(&sender, &mut peer).await;

    peer.resume.notify_one();
    let outcome = tokio::time::timeout(SETTLES_WITHIN, draining.streaming)
        .await
        .expect("the stream settles")
        .expect("the stream does not panic");

    outcome.expect("the stream finishes on the draining connection");
    assert_eq!(
        draining.received.load(Ordering::Acquire),
        usize::from(CHUNKS)
    );
    sender.shutdown().await;
}

#[tokio::test]
async fn shutdown_closes_a_connection_that_drains_after_goaway() {
    let mut peer = draining_peer().await;
    let sender = sender();
    let draining = stream_until_a_reconnect_fails(&sender, &mut peer).await;

    let started = Instant::now();
    sender.shutdown().await;

    assert!(started.elapsed() < SHUTDOWN_WITHIN);
    tokio::time::timeout(SETTLES_WITHIN, peer.disconnected)
        .await
        .expect("the draining connection closes")
        .expect("the peer reports the close");
    let outcome = tokio::time::timeout(SETTLES_WITHIN, draining.streaming)
        .await
        .expect("the stream settles")
        .expect("the stream does not panic");
    assert_eq!(
        outcome.expect_err("shutdown ends the stream").code(),
        codes::TRANSPORT_PEER_UNAVAILABLE
    );
    assert_eq!(
        draining.received.load(Ordering::Acquire),
        usize::from(CHUNKS_BEFORE_GOAWAY)
    );
}
