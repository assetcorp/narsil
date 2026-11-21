mod support;

use std::sync::{Arc, mpsc};
use std::time::Duration;

use bytes::Bytes;
use narsil_cluster::error::ClusterError;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use support::{FRAME_RESPONSE, FRAME_STREAM_END, envelope, frame, read_frame};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Notify;

#[tokio::test]
async fn a_late_stream_end_does_not_cancel_a_unary_request_that_reuses_the_id() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the peer listens");
    let target = listener
        .local_addr()
        .expect("the peer has an address")
        .to_string();
    let serving = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("the client connects");
        for payload in [b"first".as_slice(), b"second".as_slice()] {
            let request = read_frame(&mut socket).await.expect("the request arrives");
            let id = request.text("requestId");
            if payload == b"second" {
                socket
                    .write_all(&frame(FRAME_STREAM_END, &id, &[]))
                    .await
                    .expect("the previous handler finishes");
            }
            let answer = envelope("test.answer", &id, payload);
            socket
                .write_all(&frame(FRAME_RESPONSE, &id, &answer))
                .await
                .expect("the reply leaves");
        }
    });
    let client =
        TcpTransport::new("caller", TcpTransportConfig::default()).expect("the config is valid");
    for payload in [b"first".as_slice(), b"second".as_slice()] {
        let request = TransportMessage::new("test.request", "caller", "reused", Bytes::new());
        let reply = client
            .send(&target, request)
            .await
            .expect("the unary request receives its answer");
        assert_eq!(reply.payload.as_ref(), payload);
    }
    serving.await.expect("the peer completes");
    client.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_stream_callback_cannot_remove_a_later_request_with_the_same_id() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the peer listens");
    let target = listener
        .local_addr()
        .expect("the peer has an address")
        .to_string();
    let (release, released) = mpsc::channel();
    let entered = Arc::new(Notify::new());
    let serving = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("the client connects");
        let request = read_frame(&mut socket)
            .await
            .expect("the stream request arrives");
        let id = request.text("requestId");
        socket
            .write_all(&frame(
                FRAME_RESPONSE,
                &id,
                &envelope("test.chunk", &id, b"chunk"),
            ))
            .await
            .expect("the stream chunk leaves");
        let request = read_frame(&mut socket)
            .await
            .expect("the replacement request arrives");
        assert_eq!(request.text("requestId"), id);
        release.send(()).expect("the old callback can finish");
        socket
            .write_all(&frame(
                FRAME_RESPONSE,
                &id,
                &envelope("test.answer", &id, b"replacement"),
            ))
            .await
            .expect("the replacement reply leaves");
    });
    let client = Arc::new(
        TcpTransport::new("caller", TcpTransportConfig::default()).expect("the config is valid"),
    );
    let streaming_client = Arc::clone(&client);
    let streaming_target = target.clone();
    let callback_entered = Arc::clone(&entered);
    let streaming = tokio::spawn(async move {
        streaming_client
            .stream(
                &streaming_target,
                TransportMessage::new("test.stream", "caller", "reused", Bytes::new()),
                Box::new(move |_| {
                    callback_entered.notify_one();
                    released
                        .recv_timeout(Duration::from_secs(5))
                        .expect("the replacement request unblocks the callback");
                    Err(ClusterError::new(
                        "CHUNK_REJECTED",
                        "The cancelled callback failed",
                    ))
                }),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("the callback starts");
    streaming.abort();
    assert!(
        streaming
            .await
            .expect_err("the stream is cancelled")
            .is_cancelled()
    );
    let reply = client
        .send(
            &target,
            TransportMessage::new("test.request", "caller", "reused", Bytes::new()),
        )
        .await
        .expect("the replacement request receives its reply");
    assert_eq!(reply.payload.as_ref(), b"replacement");
    serving.await.expect("the peer completes");
    client.shutdown().await;
}
