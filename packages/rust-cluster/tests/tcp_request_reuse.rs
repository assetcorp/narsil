mod support;

use bytes::Bytes;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use support::{FRAME_RESPONSE, FRAME_STREAM_END, envelope, frame, read_frame};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

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
