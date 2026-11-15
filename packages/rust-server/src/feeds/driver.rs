use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::changes::ChangesFeed;
use super::constants::FEED_INBOUND_PAUSE_BYTES;
use super::core::Core;
use super::socket::Inbound;
use super::sync::SyncFeed;
use super::wire::{CLOSE_CREDENTIAL_EXPIRED, CLOSE_POLICY, CLOSE_TOO_LARGE};

pub(crate) enum Protocol {
    Sync(Box<SyncFeed>),
    Changes(Box<ChangesFeed>),
}

impl Protocol {
    fn subscribed(&self) -> bool {
        match self {
            Protocol::Sync(feed) => feed.subscribed(),
            Protocol::Changes(feed) => feed.subscribed(),
        }
    }

    fn inbound_full(&self) -> bool {
        match self {
            Protocol::Sync(feed) => feed.inbound_full(),
            Protocol::Changes(_) => false,
        }
    }

    fn timer(&self) -> Option<Instant> {
        match self {
            Protocol::Sync(feed) => feed.timer(),
            Protocol::Changes(_) => None,
        }
    }

    async fn on_timer(&mut self, core: &mut Core) {
        if let Protocol::Sync(feed) = self {
            feed.on_timer(core).await;
        }
    }

    async fn on_message(&mut self, core: &mut Core, bytes: Bytes) {
        match self {
            Protocol::Sync(feed) => feed.on_message(core, bytes).await,
            Protocol::Changes(feed) => feed.on_message(core, bytes).await,
        }
    }

    async fn pump(&mut self, core: &mut Core) {
        match self {
            Protocol::Sync(feed) => feed.pump(core).await,
            Protocol::Changes(feed) => feed.pump(core).await,
        }
    }

    async fn send_settings(&mut self, core: &mut Core) {
        if let Protocol::Sync(feed) = self {
            feed.send_settings(core).await;
        }
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

pub(crate) async fn drive(
    mut core: Core,
    mut protocol: Protocol,
    mut inbound: mpsc::Receiver<Inbound>,
) {
    let mut wants_pump = false;
    loop {
        if core.closed() || core.outbox.socket.is_gone() {
            break;
        }
        if core.expired() {
            core.close(CLOSE_CREDENTIAL_EXPIRED, "credential expired");
            break;
        }
        let pending = core.signals.take();
        if let Some((code, reason)) = pending.close {
            core.close(code, reason);
            break;
        }
        if pending.resync_epoch {
            core.resync("epoch");
            break;
        }
        if pending.settings {
            protocol.send_settings(&mut core).await;
            if core.closed() {
                break;
            }
        }
        wants_pump |= pending.advance;
        if wants_pump {
            wants_pump = false;
            if protocol.subscribed() {
                protocol.pump(&mut core).await;
                continue;
            }
        }
        let paused = core.outbox.socket.buffered_amount() > FEED_INBOUND_PAUSE_BYTES
            || protocol.inbound_full();
        let signals = std::sync::Arc::clone(&core.signals);
        let flushed = core.outbox.socket.flush_signal();
        let mut budget = core.outbox.budget_signal();
        let waits_for_budget = core.outbox.waits_for_budget();
        let expiry = core.expiry_deadline();
        let retry = core.retry_at;
        let timer = protocol.timer();
        tokio::select! {
            biased;
            _ = signals.urgent.notified() => {}
            _ = signals.routine.notified() => {}
            _ = sleep_until(expiry) => {}
            _ = flushed.wait() => {
                let had_charge = core.outbox.has_charge();
                core.outbox.settle();
                wants_pump |= had_charge && !core.outbox.has_charge();
            }
            _ = budget.changed(), if waits_for_budget => {
                core.outbox.stop_waiting_for_budget();
                wants_pump = true;
            }
            _ = sleep_until(retry) => {
                core.retry_at = None;
                wants_pump = true;
            }
            _ = sleep_until(timer) => protocol.on_timer(&mut core).await,
            frame = inbound.recv(), if !paused => match frame {
                None => break,
                Some(Inbound::Text) => {
                    core.close(CLOSE_POLICY, "feed messages travel in binary frames");
                }
                Some(Inbound::TooLarge) => core.close(CLOSE_TOO_LARGE, "message too large"),
                Some(Inbound::Binary(bytes)) => protocol.on_message(&mut core, bytes).await,
            },
        }
    }
    if !core.closed() {
        core.outbox.end_quietly();
    }
}
