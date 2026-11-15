use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use narsil::{ErrorCode, Narsil, NarsilError};
use tokio::time::Instant;

use super::constants::{FEED_INLINE_DECODE_BYTES, TIMER_DELAY_LIMIT_MS};
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
    expires_at: Option<f64>,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1_000.0)
}

impl Core {
    pub(crate) fn new(
        engine: Arc<Narsil>,
        hub: Arc<Hub>,
        index: String,
        signals: Arc<SessionSignals>,
        outbox: Outbox,
        expires_at: Option<f64>,
    ) -> Core {
        Core {
            engine,
            hub,
            index,
            signals,
            outbox,
            retry_at: None,
            expires_at,
        }
    }

    pub(crate) fn closed(&self) -> bool {
        self.outbox.is_closed()
    }

    pub(crate) fn expired(&self) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at - now_ms() <= 0.0)
    }

    pub(crate) fn expiry_deadline(&self) -> Option<Instant> {
        let remaining = self.expires_at? - now_ms();
        let wait = remaining.clamp(0.0, TIMER_DELAY_LIMIT_MS as f64).ceil() as u64;
        Some(Instant::now() + Duration::from_millis(wait))
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
