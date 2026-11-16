use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, Sleep};

use crate::constants::{CONNECTION_IDLE_TIMEOUT_MS, MIN_BODY_BYTES_PER_IDLE_TIMEOUT};

pub(crate) struct WriteStallGuard<T> {
    inner: T,
    blocked_since: Option<Instant>,
    blocked_for: Duration,
    written: u64,
    stalled: Option<Pin<Box<Sleep>>>,
}

fn idle_timeout() -> Duration {
    Duration::from_millis(CONNECTION_IDLE_TIMEOUT_MS)
}

fn written_by(outcome: &Poll<io::Result<usize>>) -> u64 {
    match outcome {
        Poll::Ready(Ok(written)) => *written as u64,
        _ => 0,
    }
}

impl<T> WriteStallGuard<T> {
    pub(crate) fn new(inner: T) -> WriteStallGuard<T> {
        WriteStallGuard {
            inner,
            blocked_since: None,
            blocked_for: Duration::ZERO,
            written: 0,
            stalled: None,
        }
    }

    fn settle<R>(
        &mut self,
        outcome: Poll<io::Result<R>>,
        written: u64,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<R>> {
        if outcome.is_ready() {
            if let Some(since) = self.blocked_since.take() {
                self.blocked_for += since.elapsed();
            }
            self.written = self.written.saturating_add(written);
            if self.written >= MIN_BODY_BYTES_PER_IDLE_TIMEOUT {
                self.written = 0;
                self.blocked_for = Duration::ZERO;
            }
            return outcome;
        }
        let newly_blocked = self.blocked_since.is_none();
        let since = *self.blocked_since.get_or_insert_with(Instant::now);
        let deadline = since + idle_timeout().saturating_sub(self.blocked_for);
        let stalled = self
            .stalled
            .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(deadline)));
        if newly_blocked {
            stalled.as_mut().reset(deadline);
        }
        if stalled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the client read too little of the answer within the idle timeout",
            )));
        }
        Poll::Pending
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for WriteStallGuard<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for WriteStallGuard<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let outcome = Pin::new(&mut self.inner).poll_write(cx, buf);
        let written = written_by(&outcome);
        self.settle(outcome, written, cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let outcome = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        let written = written_by(&outcome);
        self.settle(outcome, written, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let outcome = Pin::new(&mut self.inner).poll_flush(cx);
        self.settle(outcome, 0, cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let outcome = Pin::new(&mut self.inner).poll_shutdown(cx);
        self.settle(outcome, 0, cx)
    }
}
