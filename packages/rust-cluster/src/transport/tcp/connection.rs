use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use narsil::Value;
use tokio::io::ReadHalf;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;

use super::frame::{
    FRAME_TYPE_RESPONSE, FRAME_TYPE_STREAM_CHUNK, FRAME_TYPE_STREAM_END, Frame, read_frame,
};
use super::server::{Outbound, write_frames};
use crate::constants::OUTBOUND_FRAME_QUEUE_LENGTH;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{CARRIER_ERROR_TYPE, TransportMessage, decode_message};
use crate::transport::ChunkHandler;
use crate::transport::io::PeerStream;
use crate::transport::peers::PeerLink;
use crate::transport::run_handler::call_chunk_handler;

pub(crate) struct StreamWaiter {
    handler: Mutex<ChunkHandler>,
    pub(crate) progress: Notify,
    done: Mutex<Option<oneshot::Sender<ClusterResult<()>>>>,
}

impl StreamWaiter {
    pub(crate) fn new(
        handler: ChunkHandler,
    ) -> (Arc<StreamWaiter>, oneshot::Receiver<ClusterResult<()>>) {
        let (done, finished) = oneshot::channel();
        let waiter = Arc::new(StreamWaiter {
            handler: Mutex::new(handler),
            progress: Notify::new(),
            done: Mutex::new(Some(done)),
        });
        (waiter, finished)
    }

    fn finish(&self, result: ClusterResult<()>) {
        if let Some(done) = lock(&self.done).take() {
            let _ = done.send(result);
        }
    }
}

pub(crate) enum Waiter {
    Request(oneshot::Sender<ClusterResult<TransportMessage>>),
    Stream(Arc<StreamWaiter>),
}

#[derive(Default)]
struct Pending {
    waiters: HashMap<String, (u64, Waiter)>,
    next_ticket: u64,
    lost: Option<ClusterError>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct Connection {
    target: String,
    pub(crate) queue: mpsc::Sender<Outbound>,
    pending: Mutex<Pending>,
    alive: AtomicBool,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

pub(crate) fn peer_unavailable(target: &str, message: String) -> ClusterError {
    ClusterError::new(codes::TRANSPORT_PEER_UNAVAILABLE, message)
        .with_detail("target", Value::String(target.to_string()))
}

fn decode_failed(target: &str, request_id: &str, message: String) -> ClusterError {
    ClusterError::new(codes::TRANSPORT_DECODE_FAILED, message)
        .with_detail("target", Value::String(target.to_string()))
        .with_detail("requestId", Value::String(request_id.to_string()))
}

impl Connection {
    pub(crate) fn start(target: &str, stream: PeerStream) -> Arc<Connection> {
        let (reader, writer) = tokio::io::split(stream);
        let (queue, outbound) = mpsc::channel(OUTBOUND_FRAME_QUEUE_LENGTH);
        let connection = Arc::new(Connection {
            target: target.to_string(),
            queue,
            pending: Mutex::new(Pending::default()),
            alive: AtomicBool::new(true),
            tasks: Mutex::new(Vec::new()),
        });
        {
            let mut tasks = lock(&connection.tasks);
            tasks.push(tokio::spawn(write_frames(writer, outbound)));
            tasks.push(tokio::spawn(read_answers(Arc::clone(&connection), reader)));
        }
        connection
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(crate) fn register(&self, request_id: &str, waiter: Waiter) -> ClusterResult<u64> {
        let mut pending = lock(&self.pending);
        if pending.lost.is_some() {
            return Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!(
                    "The connection to '{}' closed before the request left",
                    self.target
                ),
            ));
        }
        if pending.waiters.contains_key(request_id) {
            return Err(ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!(
                    "A request with the id '{request_id}' already waits for '{}', so this one was not sent",
                    self.target
                ),
            ));
        }
        let ticket = pending.next_ticket;
        pending.next_ticket += 1;
        pending
            .waiters
            .insert(request_id.to_string(), (ticket, waiter));
        Ok(ticket)
    }

    pub(crate) fn release(&self, request_id: &str, ticket: u64) {
        let mut pending = lock(&self.pending);
        if pending
            .waiters
            .get(request_id)
            .is_some_and(|(held, _)| *held == ticket)
        {
            pending.waiters.remove(request_id);
        }
    }

    fn forget_stream(&self, request_id: &str, expected: &StreamWaiter) {
        let mut pending = lock(&self.pending);
        if matches!(pending.waiters.get(request_id), Some((_, Waiter::Stream(waiter))) if std::ptr::eq(waiter.as_ref(), expected))
        {
            pending.waiters.remove(request_id);
        }
    }

    fn response_waiter(&self, request_id: &str) -> Option<Waiter> {
        let mut pending = lock(&self.pending);
        if let Some((_, Waiter::Stream(waiter))) = pending.waiters.get(request_id) {
            return Some(Waiter::Stream(Arc::clone(waiter)));
        }
        pending.waiters.remove(request_id).map(|(_, waiter)| waiter)
    }

    fn stream_waiter(&self, request_id: &str) -> Option<Arc<StreamWaiter>> {
        match lock(&self.pending).waiters.get(request_id) {
            Some((_, Waiter::Stream(waiter))) => Some(Arc::clone(waiter)),
            _ => None,
        }
    }

    fn take_stream_waiter(&self, request_id: &str) -> Option<Arc<StreamWaiter>> {
        let mut pending = lock(&self.pending);
        if !matches!(
            pending.waiters.get(request_id),
            Some((_, Waiter::Stream(_)))
        ) {
            return None;
        }
        match pending.waiters.remove(request_id) {
            Some((_, Waiter::Stream(waiter))) => Some(waiter),
            _ => None,
        }
    }

    pub(crate) fn close(&self, error: ClusterError) {
        self.alive.store(false, Ordering::Release);
        let waiters = {
            let mut pending = lock(&self.pending);
            pending.lost.get_or_insert(error.clone());
            std::mem::take(&mut pending.waiters)
        };
        for (_, waiter) in waiters.into_values() {
            match waiter {
                Waiter::Request(answer) => {
                    let _ = answer.send(Err(error.clone()));
                }
                Waiter::Stream(waiter) => waiter.finish(Err(error.clone())),
            }
        }
        for task in lock(&self.tasks).iter() {
            task.abort();
        }
    }

    fn deliver_chunk(&self, request_id: &str, waiter: &StreamWaiter, chunk: Bytes) {
        match call_chunk_handler(&mut lock(&waiter.handler), chunk) {
            Ok(()) => waiter.progress.notify_one(),
            Err(error) => {
                self.forget_stream(request_id, waiter);
                waiter.finish(Err(error));
            }
        }
    }

    fn answer_stream_with(&self, request_id: &str, waiter: &StreamWaiter, data: &Bytes) {
        match decode_message(data) {
            Ok(message) if message.message_type == CARRIER_ERROR_TYPE => {
                self.forget_stream(request_id, waiter);
                waiter.finish(Err(peer_unavailable(
                    &self.target,
                    format!(
                        "The listener on '{}' failed: {}",
                        self.target,
                        String::from_utf8_lossy(&message.payload)
                    ),
                )
                .with_detail("requestId", Value::String(request_id.to_string()))));
            }
            Ok(message) => self.deliver_chunk(request_id, waiter, message.payload),
            Err(error) => {
                self.forget_stream(request_id, waiter);
                waiter.finish(Err(decode_failed(
                    &self.target,
                    request_id,
                    format!("Failed to decode stream frame: {}", error.message()),
                )));
            }
        }
    }

    fn dispatch(&self, frame: Frame) {
        match frame.frame_type {
            FRAME_TYPE_RESPONSE => match self.response_waiter(&frame.request_id) {
                Some(Waiter::Stream(waiter)) => {
                    self.answer_stream_with(&frame.request_id, &waiter, &frame.data)
                }
                Some(Waiter::Request(answer)) => {
                    let decoded = decode_message(&frame.data).map_err(|error| {
                        decode_failed(
                            &self.target,
                            &frame.request_id,
                            format!("Failed to decode response: {}", error.message()),
                        )
                    });
                    let _ = answer.send(decoded);
                }
                None => {}
            },
            FRAME_TYPE_STREAM_CHUNK => {
                if let Some(waiter) = self.stream_waiter(&frame.request_id) {
                    self.deliver_chunk(&frame.request_id, &waiter, frame.data);
                }
            }
            FRAME_TYPE_STREAM_END => {
                if let Some(waiter) = self.take_stream_waiter(&frame.request_id) {
                    waiter.finish(Ok(()));
                }
            }
            _ => {}
        }
    }
}

impl PeerLink for Arc<Connection> {
    fn is_usable(&self) -> bool {
        self.is_alive()
    }

    fn is_finished(&self) -> bool {
        lock(&self.tasks).iter().all(JoinHandle::is_finished)
    }

    fn shut_down(&self) {
        self.close(peer_unavailable(
            &self.target,
            "Connection pool shutting down".to_string(),
        ));
    }

    async fn closed(&self) {
        let tasks = std::mem::take(&mut *lock(&self.tasks));
        for task in tasks {
            let _ = task.await;
        }
    }
}

async fn read_answers(connection: Arc<Connection>, mut reader: ReadHalf<PeerStream>) {
    loop {
        match read_frame(&mut reader).await {
            Ok(frame) => connection.dispatch(frame),
            Err(_) => {
                let target = connection.target.clone();
                connection.close(peer_unavailable(
                    &target,
                    format!("Connection to '{target}' closed before a response was received"),
                ));
                return;
            }
        }
    }
}
