use std::collections::VecDeque;
use std::time::Duration;

use narsil::{BoundsFreshness, Value};
use tokio::time::Instant;

use super::SyncFeed;
use super::reads::bounds_of;
use crate::feeds::constants::FEED_HEAD_RETRY_MS;
use crate::feeds::core::Core;
use crate::feeds::hub::SYNC_OFF_REASON;
use crate::feeds::wire::{message, position_list};

impl SyncFeed {
    pub(super) async fn begin_checkpoint(&mut self, core: &mut Core, id: u32) {
        let (index, count) = (core.index.clone(), self.sent.len());
        let Some(bounds) = core
            .blocking(move |source| bounds_of(source, &index, count, BoundsFreshness::Current))
            .await
        else {
            return;
        };
        match bounds {
            Ok(bounds) => {
                let covering = bounds.iter().map(|bounds| bounds.highest_seq_no).collect();
                self.checkpoints.push_back((id, covering));
                self.answer_checkpoints(core).await;
            }
            Err(error) => core.fail(&error, SYNC_OFF_REASON),
        }
    }

    pub(crate) async fn on_timer(&mut self, core: &mut Core) {
        self.checkpoint_retry_at = None;
        self.answer_checkpoints(core).await;
    }

    async fn answer_checkpoints(&mut self, core: &mut Core) {
        let (index, count) = (core.index.clone(), self.sent.len());
        let Some(bounds) = core
            .blocking(move |source| bounds_of(source, &index, count, BoundsFreshness::Current))
            .await
        else {
            return;
        };
        let bounds = match bounds {
            Ok(bounds) => bounds,
            Err(error) => return core.fail(&error, SYNC_OFF_REASON),
        };
        let heads: Vec<u64> = bounds.iter().map(|bounds| bounds.head).collect();
        let mut answered = false;
        let mut waiting = VecDeque::with_capacity(self.checkpoints.len());
        while let Some((id, mut covering)) = self.checkpoints.pop_front() {
            let mut covered = true;
            for (partition, bounds) in bounds.iter().enumerate() {
                let Some(needed) = covering.get_mut(partition) else {
                    continue;
                };
                *needed = (*needed).min(bounds.highest_seq_no);
                let reachable = bounds
                    .head
                    .max(self.sent.get(partition).copied().unwrap_or(0));
                covered &= reachable >= *needed;
            }
            if !covered {
                waiting.push_back((id, covering));
                continue;
            }
            let answer = message(
                "checkpoint",
                vec![
                    ("id", Value::Number(id as f64)),
                    ("heads", position_list(&heads)),
                ],
            );
            if let Some(answer) = answer {
                core.outbox.send(answer);
                answered = true;
            }
        }
        self.checkpoints = waiting;
        if !self.checkpoints.is_empty() {
            self.checkpoint_retry_at =
                Some(Instant::now() + Duration::from_millis(FEED_HEAD_RETRY_MS));
        }
        if answered {
            self.pump(core).await;
        }
    }
}
