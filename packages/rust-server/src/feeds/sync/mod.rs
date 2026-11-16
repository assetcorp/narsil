mod checkpoint;
mod reads;

use std::collections::VecDeque;
use std::time::Duration;

use bytes::Bytes;
use narsil::{SyncCursor, Value};
use tokio::time::Instant;

use super::constants::{FEED_HEAD_RETRY_MS, MAX_PENDING_CHECKPOINTS};
use super::core::Core;
use super::hub::SYNC_OFF_REASON;
use super::outbox::Window;
use super::wire::{
    CLOSE_POLICY, CLOSE_RESYNC, DeviceMessage, Position, device_message_of, message, position_list,
    seq_nos_by_partition,
};
use reads::{Opened, bounds_of, open, state_of};

#[derive(Default)]
pub(crate) struct SyncFeed {
    subscribed: bool,
    epoch: String,
    sent: Vec<u64>,
    heads: Vec<u64>,
    window: Option<Window>,
    cursors: Vec<Option<SyncCursor>>,
    checkpoints: VecDeque<(u32, Vec<u64>)>,
    checkpoint_retry_at: Option<Instant>,
    settings_due: bool,
}

impl SyncFeed {
    pub(crate) fn subscribed(&self) -> bool {
        self.subscribed
    }

    pub(crate) fn inbound_full(&self) -> bool {
        self.checkpoints.len() >= MAX_PENDING_CHECKPOINTS
    }

    pub(crate) fn timer(&self) -> Option<Instant> {
        self.checkpoint_retry_at
    }

    pub(crate) async fn on_message(&mut self, core: &mut Core, bytes: Bytes) {
        let Some(decoded) = core.decode(bytes, device_message_of).await else {
            return;
        };
        let Some(message) = decoded else {
            core.close(CLOSE_POLICY, "invalid message");
            return;
        };
        match message {
            DeviceMessage::Subscribe { .. } if self.subscribed => {
                core.close(CLOSE_POLICY, "subscribe after the first message");
            }
            DeviceMessage::Subscribe { epoch, positions } => {
                self.subscribe(core, epoch, positions).await;
            }
            _ if !self.subscribed => core.close(CLOSE_POLICY, "subscribe must come first"),
            DeviceMessage::Ack(positions) => self.acknowledge(core, &positions).await,
            DeviceMessage::Checkpoint(id) => self.begin_checkpoint(core, id).await,
        }
    }

    async fn subscribe(&mut self, core: &mut Core, epoch: String, positions: Vec<Position>) {
        let index = core.index.clone();
        let Some(state) = core.blocking(move |engine| state_of(engine, &index)).await else {
            return;
        };
        let state = match state {
            Ok(Some(state)) => state,
            Ok(None) => return core.close(CLOSE_RESYNC, SYNC_OFF_REASON),
            Err(error) => return core.fail(&error, SYNC_OFF_REASON),
        };
        if epoch != state.epoch {
            return core.resync("epoch");
        }
        let count = state.partition_count as usize;
        let Some(seq_nos) = seq_nos_by_partition(&positions, count) else {
            return core.close(CLOSE_POLICY, "positions must name each partition once");
        };
        let (index, held_epoch, held) = (core.index.clone(), epoch.clone(), seq_nos.clone());
        let Some(opened) = core
            .catch_up(move |engine| open(engine, &index, &held_epoch, &held))
            .await
        else {
            return;
        };
        let (heads, bytes_behind, snapshot_bytes) = match opened {
            Ok(Opened::Subscribed {
                heads,
                bytes_behind,
                snapshot_bytes,
            }) => (heads, bytes_behind, snapshot_bytes),
            Ok(Opened::Resync(reason)) => return core.resync(reason),
            Err(error) => return core.fail(&error, SYNC_OFF_REASON),
        };
        if core.closed() {
            return;
        }
        let window_bytes = core.hub.options.window_bytes;
        let Some(subscribed) = message(
            "subscribed",
            vec![
                ("epoch", Value::String(epoch.clone())),
                ("partitionCount", Value::Number(count as f64)),
                ("heads", position_list(&heads)),
                ("bytesBehind", Value::Number(bytes_behind as f64)),
                ("snapshotBytes", Value::Number(snapshot_bytes as f64)),
                ("windowBytes", Value::Number(window_bytes as f64)),
                ("settings", Value::Object(state.settings)),
            ],
        ) else {
            return core.fail_quietly();
        };
        self.epoch = epoch;
        self.sent = seq_nos;
        self.heads = heads;
        self.window = Some(Window::new(window_bytes, count));
        self.cursors = (0..count).map(|_| None).collect();
        self.subscribed = true;
        core.outbox.send(subscribed);
        self.pump(core).await;
    }

    async fn acknowledge(&mut self, core: &mut Core, positions: &[Position]) {
        let Some(seq_nos) = seq_nos_by_partition(positions, self.sent.len()) else {
            return core.close(CLOSE_POLICY, "positions must name each partition once");
        };
        if seq_nos
            .iter()
            .zip(&self.sent)
            .any(|(acked, sent)| acked > sent)
        {
            return core.close(CLOSE_POLICY, "acknowledgement above a sent entry");
        }
        if let Some(window) = self.window.as_mut() {
            for (partition, seq_no) in seq_nos.iter().enumerate() {
                window.release_through(partition, *seq_no);
            }
        }
        self.pump(core).await;
    }

    pub(crate) async fn send_settings(&mut self, core: &mut Core) {
        if !self.subscribed {
            return;
        }
        self.settings_due = true;
        self.flush_settings(core).await;
    }

    async fn flush_settings(&mut self, core: &mut Core) {
        if !self.settings_due || core.closed() || core.outbox.has_charge() {
            return;
        }
        let index = core.index.clone();
        let Some(read) = core.blocking(move |engine| state_of(engine, &index)).await else {
            return;
        };
        let Ok(Some(state)) = read else {
            self.settings_due = false;
            return;
        };
        let Some(settings) = message(
            "settings",
            vec![("settings", Value::Object(state.settings))],
        ) else {
            self.settings_due = false;
            return;
        };
        if !core.outbox.charge(settings.len() as u64) {
            return;
        }
        self.settings_due = false;
        core.outbox.send(settings);
    }

    pub(crate) async fn pump(&mut self, core: &mut Core) {
        if !self.subscribed || core.closed() {
            return;
        }
        self.flush_settings(core).await;
        if self.settings_due || !self.refresh_heads(core).await {
            return;
        }
        self.send_behind(core).await;
    }

    async fn refresh_heads(&mut self, core: &mut Core) -> bool {
        let (index, count) = (core.index.clone(), self.heads.len());
        let Some(refreshed) = core
            .blocking(move |engine| {
                let bounds = bounds_of(engine, &index, count);
                (state_of(engine, &index), bounds)
            })
            .await
        else {
            return false;
        };
        let (current, bounds) = refreshed;
        if !self.same_epoch(core, current) {
            return false;
        }
        let bounds = match bounds {
            Ok(bounds) => bounds,
            Err(error) => {
                core.fail(&error, SYNC_OFF_REASON);
                return false;
            }
        };
        let mut undurable = false;
        for (head, bounds) in self.heads.iter_mut().zip(&bounds) {
            *head = (*head).max(bounds.head);
            undurable |= bounds.highest_seq_no > *head;
        }
        if undurable && core.retry_at.is_none() {
            core.retry_at = Some(Instant::now() + Duration::from_millis(FEED_HEAD_RETRY_MS));
        }
        true
    }
}
