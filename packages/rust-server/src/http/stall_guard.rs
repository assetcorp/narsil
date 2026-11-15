use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

use crate::constants::CONNECTION_IDLE_TIMEOUT_MS;

pub(crate) struct WriteStallGuard<T> {
    inner: T,
    stalled: Option<Pin<Box<Sleep>>>,
}

impl<T> WriteStallGuard<T> {
    pub(crate) fn new(inner: T) -> WriteStallGuard<T> {
        WriteStallGuard {
            inner,
            stalled: None,
        }
    }

    fn settle<R>(
        &mut self,
        outcome: Poll<io::Result<R>>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<R>> {
        if outcome.is_ready() {
            self.stalled = None;
            return outcome;
        }
        let stalled = self.stalled.get_or_insert_with(|| {
            Box::pin(tokio::time::sleep(Duration::from_millis(
                CONNECTION_IDLE_TIMEOUT_MS,
            )))
        });
        if stalled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the client read nothing of the answer within the idle timeout",
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
        self.settle(outcome, cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let outcome = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        self.settle(outcome, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let outcome = Pin::new(&mut self.inner).poll_flush(cx);
        self.settle(outcome, cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let outcome = Pin::new(&mut self.inner).poll_shutdown(cx);
        self.settle(outcome, cx)
    }
}
