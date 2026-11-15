use std::io::{self, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame, SizeHint};
use narsil::Narsil;
use tokio::sync::mpsc;

use super::constants::STREAM_CHUNKS_IN_FLIGHT;
use crate::constants::RESPONSE_STREAM_CHUNK_BYTES;
use crate::errors::{Outcome, ServerError};
use crate::http::respond::{HttpResponse, ResponseBody, with_body};

pub(crate) type ChunkSender = mpsc::Sender<io::Result<Bytes>>;
pub(crate) type ChunkReceiver = mpsc::Receiver<io::Result<Bytes>>;

pub(crate) fn chunk_channel() -> (ChunkSender, ChunkReceiver) {
    mpsc::channel(STREAM_CHUNKS_IN_FLIGHT)
}

pub(crate) fn stream_cut_short() -> io::Error {
    io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "the engine stopped before the answer ended",
    )
}

fn caller_left() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "the caller closed the connection",
    )
}

struct ChunkWriter {
    sender: ChunkSender,
    pending: Vec<u8>,
    sent_any: bool,
}

impl ChunkWriter {
    fn new(sender: ChunkSender) -> ChunkWriter {
        ChunkWriter {
            sender,
            pending: Vec::with_capacity(RESPONSE_STREAM_CHUNK_BYTES),
            sent_any: false,
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
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| caller_left())?;
        self.sent_any = true;
        Ok(())
    }

    fn finish(mut self, outcome: narsil::Result<()>) -> narsil::Result<()> {
        match outcome {
            Ok(()) => {
                let _ = self.send_pending();
                Ok(())
            }
            Err(_) if self.sent_any => {
                let _ = self.sender.blocking_send(Err(stream_cut_short()));
                Ok(())
            }
            Err(failure) => Err(failure),
        }
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
            Poll::Ready(Some(Ok(chunk))) => self.counted(chunk),
            Poll::Ready(Some(Err(failure))) => Poll::Ready(Some(Err(failure))),
            Poll::Ready(None) if self.remaining.is_some_and(|left| left > 0) => {
                Poll::Ready(Some(Err(stream_cut_short())))
            }
            Poll::Ready(None) => Poll::Ready(None),
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
    let (sender, mut receiver) = chunk_channel();
    let engine = Arc::clone(engine);
    let writing = tokio::task::spawn_blocking(move || {
        let mut writer = ChunkWriter::new(sender);
        let outcome = work(&engine, &mut writer);
        writer.finish(outcome)
    });
    match receiver.recv().await {
        Some(Ok(first)) => Ok(with_body(
            200,
            content_type,
            ChunkBody::boxed(Some(first), receiver, None),
        )),
        Some(Err(_)) => Err(ServerError::internal()),
        None => match writing.await {
            Ok(Ok(())) => Ok(with_body(
                200,
                content_type,
                ChunkBody::boxed(None, receiver, None),
            )),
            Ok(Err(failure)) => Err(ServerError::from(failure)),
            Err(_) => Err(ServerError::internal()),
        },
    }
}
