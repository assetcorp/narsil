use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::Error as SocketError;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use super::constants::{
    FEED_CLOSE_HANDSHAKE_MS, FEED_PING_INTERVAL_MS, FEED_SOCKET_MAX_PAYLOAD_BYTES,
    FEED_SOCKET_READ_BUFFER_BYTES, MAX_FEED_MESSAGE_BYTES,
};
use super::signals::SessionSignals;
use super::wire::close_reason_of;

type Stream = WebSocketStream<TokioIo<Upgraded>>;

pub(crate) enum Inbound {
    Binary(Bytes),
    Text,
    TooLarge,
}

enum Outbound {
    Binary(Bytes),
    Ping,
    Close(u16, String),
}

#[derive(Default)]
struct SocketShared {
    buffered: AtomicU64,
    gone: AtomicBool,
    received: AtomicBool,
    writer_done: AtomicBool,
    flushed: Notify,
    writer_finished: Notify,
}

pub(crate) struct FeedSocket {
    outbound: mpsc::UnboundedSender<Outbound>,
    shared: Arc<SocketShared>,
}

impl FeedSocket {
    pub(crate) fn send(&self, bytes: Vec<u8>) {
        let length = bytes.len() as u64;
        self.shared.buffered.fetch_add(length, Ordering::AcqRel);
        if self
            .outbound
            .send(Outbound::Binary(Bytes::from(bytes)))
            .is_err()
        {
            self.shared.buffered.fetch_sub(length, Ordering::AcqRel);
        }
    }

    pub(crate) fn buffered_amount(&self) -> u64 {
        self.shared.buffered.load(Ordering::Acquire)
    }

    pub(crate) fn close(&self, code: u16, reason: &str) {
        let _ = self
            .outbound
            .send(Outbound::Close(code, close_reason_of(reason)));
    }

    pub(crate) fn is_gone(&self) -> bool {
        self.shared.gone.load(Ordering::Acquire)
    }

    pub(crate) fn flush_signal(&self) -> FlushSignal {
        FlushSignal(Arc::clone(&self.shared))
    }
}

pub(crate) struct FlushSignal(Arc<SocketShared>);

impl FlushSignal {
    pub(crate) async fn wait(&self) {
        self.0.flushed.notified().await;
    }
}

pub(crate) fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(FEED_SOCKET_READ_BUFFER_BYTES)
        .max_message_size(Some(FEED_SOCKET_MAX_PAYLOAD_BYTES))
        .max_frame_size(Some(FEED_SOCKET_MAX_PAYLOAD_BYTES))
}

pub(crate) async fn open_stream(upgraded: Upgraded) -> Stream {
    WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(socket_config()))
        .await
}

fn peer_left(shared: &SocketShared, signals: &SessionSignals) {
    shared.gone.store(true, Ordering::Release);
    signals.wake();
}

async fn read_frames(
    mut source: SplitStream<Stream>,
    inbound: mpsc::Sender<Inbound>,
    shared: Arc<SocketShared>,
    signals: Arc<SessionSignals>,
) {
    let close_deadline = async {
        loop {
            let finished = shared.writer_finished.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            if shared.writer_done.load(Ordering::Acquire) {
                break;
            }
            finished.await;
        }
        tokio::time::sleep(Duration::from_millis(FEED_CLOSE_HANDSHAKE_MS)).await;
    };
    tokio::pin!(close_deadline);
    loop {
        let frame = tokio::select! {
            frame = source.next() => frame,
            _ = close_deadline.as_mut() => break,
        };
        shared.received.store(true, Ordering::Release);
        let forwarded = match frame {
            None => break,
            Some(Ok(Message::Binary(bytes))) if bytes.len() > MAX_FEED_MESSAGE_BYTES => {
                Inbound::TooLarge
            }
            Some(Ok(Message::Binary(bytes))) => Inbound::Binary(bytes),
            Some(Ok(Message::Text(_)) | Err(SocketError::Utf8(_))) => Inbound::Text,
            Some(Ok(Message::Close(_))) => {
                peer_left(&shared, &signals);
                continue;
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) => break,
        };
        if inbound.send(forwarded).await.is_err() {
            break;
        }
    }
    peer_left(&shared, &signals);
}

async fn write_frames(
    mut sink: SplitSink<Stream, Message>,
    mut outbound: mpsc::UnboundedReceiver<Outbound>,
    shared: Arc<SocketShared>,
    signals: Arc<SessionSignals>,
) {
    while let Some(next) = outbound.recv().await {
        let (message, length, last) = match next {
            Outbound::Binary(bytes) => {
                let length = bytes.len() as u64;
                (Message::Binary(bytes), length, false)
            }
            Outbound::Ping => (Message::Ping(Bytes::new()), 0, false),
            Outbound::Close(code, reason) => (
                Message::Close(Some(CloseFrame {
                    code: CloseCode::from(code),
                    reason: Utf8Bytes::from(reason),
                })),
                0,
                true,
            ),
        };
        let sent = sink.send(message).await;
        shared.buffered.fetch_sub(length, Ordering::AcqRel);
        shared.flushed.notify_one();
        if sent.is_err() {
            peer_left(&shared, &signals);
            break;
        }
        if last {
            break;
        }
    }
    shared.writer_done.store(true, Ordering::Release);
    shared.writer_finished.notify_waiters();
}

async fn keep_alive(shared: Arc<SocketShared>, outbound: mpsc::WeakUnboundedSender<Outbound>) {
    let period = Duration::from_millis(FEED_PING_INTERVAL_MS);
    let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let mut pinged = false;
    loop {
        ticks.tick().await;
        if shared.received.swap(false, Ordering::AcqRel) {
            pinged = false;
            continue;
        }
        let Some(outbound) = outbound.upgrade() else {
            std::future::pending::<()>().await;
            return;
        };
        if pinged || outbound.send(Outbound::Ping).is_err() {
            return;
        }
        pinged = true;
    }
}

pub(crate) async fn serve_socket<F, Fut>(stream: Stream, signals: Arc<SessionSignals>, session: F)
where
    F: FnOnce(FeedSocket, mpsc::Receiver<Inbound>) -> Fut,
    Fut: Future<Output = ()>,
{
    let (sink, source) = stream.split();
    let (inbound_sender, inbound) = mpsc::channel(1);
    let (outbound_sender, outbound) = mpsc::unbounded_channel();
    let shared = Arc::new(SocketShared::default());
    let idle = keep_alive(Arc::clone(&shared), outbound_sender.downgrade());
    let socket = FeedSocket {
        outbound: outbound_sender,
        shared: Arc::clone(&shared),
    };
    let reader = read_frames(
        source,
        inbound_sender,
        Arc::clone(&shared),
        Arc::clone(&signals),
    );
    let writer = write_frames(sink, outbound, Arc::clone(&shared), signals);
    let connection = futures_util::future::join3(reader, writer, session(socket, inbound));
    tokio::select! {
        _ = connection => {}
        _ = idle => {}
    }
}
