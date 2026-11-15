use std::collections::VecDeque;

use super::constants::MAX_QUEUED_DELIVERIES;

#[derive(Default)]
pub struct DeferredEvents {
    pending: VecDeque<(String, String)>,
    dropped: u64,
}

impl DeferredEvents {
    pub fn push(&mut self, event_type: String, body: String) -> Option<u64> {
        let mut dropped = None;
        if self.pending.len() >= MAX_QUEUED_DELIVERIES {
            self.pending.pop_front();
            self.dropped += 1;
            dropped = Some(self.dropped);
        }
        self.pending.push_back((event_type, body));
        dropped
    }

    pub fn take(&mut self) -> VecDeque<(String, String)> {
        std::mem::take(&mut self.pending)
    }
}
