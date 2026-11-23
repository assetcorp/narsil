use std::io::{self, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, SizeHint};
use narsil::Narsil;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

use super::constants::{STALLED_DOWNLOAD_DEADLINE_MS, STREAM_CHUNKS_IN_FLIGHT};
use crate::constants::RESPONSE_STREAM_CHUNK_BYTES;
use crate::errors::{Outcome, ServerError};
use crate::http::respond::{HttpResponse, ResponseBody, empty_body, with_body};

pub(crate) enum Chunk {
    Data(Bytes),
    End,
}

pub(crate) type ChunkSender = mpsc::Sender<Chunk>;
pub(crate) type ChunkReceiver = mpsc::Receiver<Chunk>;

pub(crate) fn chunk_channel() -> (ChunkSender, ChunkReceiver) {
    mpsc::channel(STREAM_CHUNKS_IN_FLIGHT)
}

fn stream_cut_short() -> io::Error {
    io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "the engine stopped before the answer ended",
    )
}

fn caller_left() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "the caller closed the connection or stopped reading",
    )
}

pub(crate) async fn deliver(sender: &ChunkSender, chunk: Chunk) -> bool {
    let deadline = Duration::from_millis(STALLED_DOWNLOAD_DEADLINE_MS);
    sender.send_timeout(chunk, deadline).await.is_ok()
}

struct ChunkWriter {
    sender: ChunkSender,
    runtime: Handle,
    pending: Vec<u8>,
}

impl ChunkWriter {
    fn new(sender: ChunkSender, runtime: Handle) -> ChunkWriter {
        ChunkWriter {
            sender,
            runtime,
            pending: Vec::with_capacity(RESPONSE_STREAM_CHUNK_BYTES),
        }
    }

    fn deliver(&self, chunk: Chunk) -> io::Result<()> {
        if self.runtime.block_on(deliver(&self.sender, chunk)) {
            Ok(())
        } else {
            Err(caller_left())
        }
    }

    fn send_pending(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(
            &mut self.pending,
            Vec::with_capacity(RESPONSE_STREAM_CHUNK_BYTES),
        ));
        self.deliver(Chunk::Data(chunk))
    }

    fn finish(mut self, outcome: narsil::Result<()>) -> narsil::Result<()> {
        if outcome.is_ok() && self.send_pending().is_ok() {
            let _ = self.deliver(Chunk::End);
        }
        outcome
    }
}

impl Write for ChunkWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let mut rest = data;
        while !rest.is_empty() {
            let room = RESPONSE_STREAM_CHUNK_BYTES.saturating_sub(self.pending.len());
            let (taken, left) = rest.split_at(room.min(rest.len()));
            self.pending.extend_from_slice(taken);
            rest = left;
            if self.pending.len() >= RESPONSE_STREAM_CHUNK_BYTES {
                self.send_pending()?;
            }
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.sender.is_closed() {
            return Err(caller_left());
        }
        Ok(())
    }
}

pub(crate) struct ChunkBody {
    first: Option<Bytes>,
    receiver: ChunkReceiver,
    remaining: Option<u64>,
}

impl ChunkBody {
    pub(crate) fn boxed(
        first: Option<Bytes>,
        receiver: ChunkReceiver,
        length: Option<u64>,
    ) -> ResponseBody {
        BodyExt::boxed(ChunkBody {
            first,
            receiver,
            remaining: length,
        })
    }

    fn counted(&mut self, chunk: Bytes) -> Poll<Option<io::Result<Frame<Bytes>>>> {
        if let Some(remaining) = &mut self.remaining {
            match remaining.checked_sub(chunk.len() as u64) {
                Some(left) => *remaining = left,
                None => return Poll::Ready(Some(Err(stream_cut_short()))),
            }
        }
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }
}

impl Body for ChunkBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<io::Result<Frame<Bytes>>>> {
        if let Some(first) = self.first.take() {
            return self.counted(first);
        }
        match self.receiver.poll_recv(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Chunk::Data(chunk))) => self.counted(chunk),
            Poll::Ready(Some(Chunk::End)) if self.remaining.is_none_or(|left| left == 0) => {
                Poll::Ready(None)
            }
            Poll::Ready(Some(Chunk::End) | None) => Poll::Ready(Some(Err(stream_cut_short()))),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match self.remaining {
            Some(remaining) => SizeHint::with_exact(remaining),
            None => SizeHint::default(),
        }
    }
}

pub(crate) async fn streamed_write<F>(
    engine: &Arc<Narsil>,
    content_type: &'static str,
    work: F,
) -> Outcome<HttpResponse>
where
    F: FnOnce(&Narsil, &mut dyn Write) -> narsil::Result<()> + Send + 'static,
{
    let engine = Arc::clone(engine);
    streamed_output(content_type, move |out| work(&engine, out)).await
}

pub(crate) async fn streamed_output<F>(content_type: &'static str, work: F) -> Outcome<HttpResponse>
where
    F: FnOnce(&mut dyn Write) -> narsil::Result<()> + Send + 'static,
{
    let (sender, mut receiver) = chunk_channel();
    let runtime = Handle::current();
    let writing = tokio::task::spawn_blocking(move || {
        let mut writer = ChunkWriter::new(sender, runtime);
        let outcome = work(&mut writer);
        writer.finish(outcome)
    });
    match receiver.recv().await {
        Some(Chunk::Data(first)) => Ok(with_body(
            200,
            content_type,
            ChunkBody::boxed(Some(first), receiver, None),
        )),
        Some(Chunk::End) => Ok(with_body(200, content_type, empty_body())),
        None => match writing.await {
            Ok(Err(failure)) => Err(ServerError::from(failure)),
            Ok(Ok(())) | Err(_) => Err(ServerError::internal()),
        },
    }
}
