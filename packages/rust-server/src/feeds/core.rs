use std::sync::Arc;

use narsil::{ErrorCode, Narsil, NarsilError};
use tokio::time::Instant;

use super::constants::FEED_INLINE_DECODE_BYTES;
use super::hub::Hub;
use super::outbox::Outbox;
use super::signals::SessionSignals;
use super::wire::{CLOSE_RESYNC, CLOSE_SERVER_ERROR, resync_message};

pub(crate) struct Core {
    pub(crate) engine: Arc<Narsil>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) index: String,
    pub(crate) signals: Arc<SessionSignals>,
    pub(crate) outbox: Outbox,
    pub(crate) retry_at: Option<Instant>,
}

pub(crate) async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl Core {
    pub(crate) fn new(
        engine: Arc<Narsil>,
        hub: Arc<Hub>,
        index: String,
        signals: Arc<SessionSignals>,
        outbox: Outbox,
    ) -> Core {
        Core {
            engine,
            hub,
            index,
            signals,
            outbox,
            retry_at: None,
        }
    }

    pub(crate) fn closed(&self) -> bool {
        self.outbox.is_closed()
    }

    pub(crate) fn expired(&self) -> bool {
        self.outbox.expired()
    }

    pub(crate) fn expiry_deadline(&self) -> Option<Instant> {
        self.outbox.expiry_deadline()
    }

    async fn expiry(&self) {
        loop {
            sleep_until(self.expiry_deadline()).await;
            if self.expired() {
                return;
            }
        }
    }

    pub(crate) fn close(&mut self, code: u16, reason: &str) {
        self.outbox.close(code, reason);
    }

    fn close_for_pending_signal(&mut self) -> bool {
        let pending = self.signals.take();
        if let Some((code, reason)) = pending.close {
            self.close(code, reason);
            return true;
        }
        false
    }

    pub(crate) fn resync(&mut self, reason: &str) {
        if self.closed() || self.close_for_pending_signal() {
            return;
        }
        if let Some(message) = resync_message(reason) {
            self.outbox.send(message);
        }
        self.close(CLOSE_RESYNC, &format!("resync {reason}"));
    }

    pub(crate) fn fail(&mut self, error: &NarsilError, off_reason: &'static str) {
        if self.closed() || self.close_for_pending_signal() {
            return;
        }
        if error.code() == ErrorCode::INDEX_NOT_FOUND {
            self.close(CLOSE_RESYNC, off_reason);
            return;
        }
        let feed = match self.hub.kind {
            super::FeedKind::Sync => "A device sync feed",
            super::FeedKind::Changes => "A change feed",
        };
        eprintln!("{feed} failed to read its index: {error}");
        self.close(CLOSE_SERVER_ERROR, "feed read failed");
    }

    pub(crate) fn fail_quietly(&mut self) {
        if self.closed() || self.close_for_pending_signal() {
            return;
        }
        self.close(CLOSE_SERVER_ERROR, "feed read failed");
    }

    pub(crate) async fn blocking<T, F>(&self, work: F) -> Option<T>
    where
        T: Send + 'static,
        F: FnOnce(&Narsil) -> T + Send + 'static,
    {
        let engine = Arc::clone(&self.engine);
        let task = tokio::task::spawn_blocking(move || work(&engine));
        tokio::select! {
            biased;
            _ = self.signals.urgent.notified() => None,
            _ = self.expiry() => None,
            joined = task => joined.ok(),
        }
    }

    pub(crate) async fn catch_up<T, F>(&self, work: F) -> Option<T>
    where
        T: Send + 'static,
        F: FnOnce(&Narsil) -> T + Send + 'static,
    {
        let reads = Arc::clone(&self.hub.reads);
        let permit = tokio::select! {
            biased;
            _ = self.signals.urgent.notified() => None,
            _ = self.expiry() => None,
            permit = reads.acquire_owned() => permit.ok(),
        }?;
        self.blocking(move |engine| {
            let _permit = permit;
            work(engine)
        })
        .await
    }

    pub(crate) async fn decode<T, F>(&self, bytes: bytes::Bytes, decode: F) -> Option<Option<T>>
    where
        T: Send + 'static,
        F: FnOnce(&[u8]) -> Option<T> + Send + 'static,
    {
        if bytes.len() <= FEED_INLINE_DECODE_BYTES {
            return Some(decode(&bytes));
        }
        self.blocking(move |_| decode(&bytes)).await
    }
}
